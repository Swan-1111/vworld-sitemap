"""외부 API와 사용자 out/ 자료를 사용하지 않는 작업·내보내기 회귀 테스트."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import common
import web
import aerial


@pytest.mark.parametrize("result", ["collected-site", None])
def test_pipeline_uses_its_own_child_result(monkeypatch, result):
    job = {"status": "running", "log": []}
    monkeypatch.setattr(web, "JOBS", {"test": job})
    monkeypatch.setattr(web, "last_site", lambda: "another-users-site")
    calls = []

    def process(argv, **kwargs):
        calls.append(argv)
        message = "@@SITE " + json.dumps(result) if result and len(calls) == 1 else ""
        return SimpleNamespace(stdout=io.StringIO(message), returncode=0, wait=lambda: 0)

    monkeypatch.setattr(web.subprocess, "Popen", process)
    web.run_pipeline("test", "주소", 350, None, True, terrain=False)
    if result:
        assert job["status"] == "done"
        assert job["site"] == result
        assert len(calls) == 3
        assert all(argv[argv.index("--name") + 1] == result for argv in calls[1:])
    else:
        assert job["status"] == "error"
        assert len(calls) == 1


@pytest.mark.parametrize("model,fields", [
    (web.AnalyzeRequest, {"radius": -10}),
    (web.AnalyzeRequest, {"radius": float("nan")}),
    (web.AnalyzeRequest, {"bbox": [0, 0, float("inf"), 1]}),
    (web.BoundaryRequest, {"ring": [[0, 0], [1, 1]]}),
    (web.BoundaryRequest, {"ring": [[0, 0], [1, 1], [0, 1], [1, 0]]}),
    (web.BoundaryRequest, {"ring": [[181, 0], [1, 1], [0, 1]]}),
    (web.ExportRequest, {"scope": "typo"}),
    (web.ExportRequest, {"layers": ["unknown-layer"]}),
])
def test_invalid_input_is_rejected_before_work(model, fields):
    with pytest.raises(ValidationError):
        model(**fields)


@pytest.fixture
def export_site(tmp_path, monkeypatch):
    monkeypatch.setattr(common, "OUT_ROOT", str(tmp_path))
    site = common.Site("test").ensure()
    monkeypatch.setattr(web, "_site_or_404", lambda name: site)
    return site


def test_parallel_exports_keep_their_own_boundary_and_file(export_site, monkeypatch):
    barrier = threading.Barrier(2)
    def run(argv, **kwargs):
        clip = Path(argv[argv.index("--clip-geojson") + 1])
        output = Path(argv[argv.index("--out") + 1])
        barrier.wait(timeout=5)
        output.write_text(clip.read_text(encoding="utf-8"), encoding="utf-8")
        return SimpleNamespace(returncode=0, stdout="done", stderr="")

    monkeypatch.setattr(web.subprocess, "run", run)
    rings = [[[x, 0], [x + 1, 0], [x, 1]] for x in [0, 5]]
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda ring: web.export_dxf("test", web.ExportRequest(
            scope="area", ring=ring)), rings))
    assert results[0]["download_kind"] != results[1]["download_kind"]
    for ring, result in zip(rings, results):
        response = web.download("test", result["download_kind"])
        data = json.loads(Path(response.path).read_text(encoding="utf-8"))
        assert data["features"][0]["geometry"]["coordinates"][0] == ring + [ring[0]]
    assert not list(Path(export_site.dir).rglob("*.geojson"))


def test_export_cleans_clip_if_process_cannot_start(export_site, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("cannot start process")
    monkeypatch.setattr(web.subprocess, "run", fail)
    with pytest.raises(OSError):
        web.export_dxf("test", web.ExportRequest(scope="area", ring=[[0, 0], [1, 0], [0, 1]]))
    assert not list(Path(export_site.dir).rglob("*.geojson"))


def test_project_export_requires_a_boundary(export_site):
    with pytest.raises(web.HTTPException) as error:
        web.export_dxf("test", web.ExportRequest(scope="project"))
    assert error.value.status_code == 400


def test_aerial_cache_includes_projection_origin(monkeypatch):
    site = SimpleNamespace(dir="unused-test-path", read_manifest=lambda: {"site": "same-name"})
    frame = SimpleNamespace(crs="EPSG:5186", ox=200000.0, oy=550000.0)
    monkeypatch.setattr(aerial, "Site", lambda name: site)
    monkeypatch.setattr(aerial, "site_frame", lambda site: frame)
    monkeypatch.setattr(aerial, "_fresh", lambda path: True)
    first = aerial.build("same-name", 350)
    assert aerial.build("same-name", 350) == first
    frame.ox += 1000
    moved = aerial.build("same-name", 350)
    assert moved != first
    frame.crs = "EPSG:5187"
    assert aerial.build("same-name", 350) != moved
