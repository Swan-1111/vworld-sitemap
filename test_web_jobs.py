"""공유 서버의 백그라운드 작업 제한 회귀 검사."""

from __future__ import annotations

import time
import base64

import pytest
from fastapi import HTTPException

import web


class _RequestStub:
    headers = {}


def test_active_job_limit_and_finished_job_cleanup(monkeypatch):
    monkeypatch.setattr(web, "MAX_ACTIVE_JOBS", 1)
    monkeypatch.setattr(web, "JOB_TTL_SECONDS", 1)
    web.JOBS.clear()
    try:
        _job_id, job = web._create_job({"status": "running", "log": []})
        with pytest.raises(HTTPException) as caught:
            web._create_job({"status": "running", "log": []})
        assert caught.value.status_code == 429

        job["status"] = "done"
        job["finished_at"] = time.time() - 2
        web._cleanup_jobs_locked()
        assert not web.JOBS
    finally:
        web.JOBS.clear()


def test_nano_banana_render_sends_image_without_storing(monkeypatch):
    png = b"\x89PNG\r\n\x1a\n" + b"test-image"
    encoded = base64.b64encode(png).decode("ascii")
    captured = {}

    class Response:
        ok = True
        status_code = 200

        def json(self):
            return {"status": "completed", "steps": [{"type": "model_output", "content": [
                {"type": "image", "mime_type": "image/png", "data": encoded},
            ]}]}

    class Session:
        def post(self, url, **kwargs):
            captured.update(url=url, **kwargs)
            return Response()

    monkeypatch.setattr(web, "gemini_key_of", lambda _request: "test-key")
    monkeypatch.setattr(web, "_env_value", lambda _name: "")
    monkeypatch.setattr(web, "network_session", lambda: Session())
    request = web.NanoRenderRequest(prompt="구도를 유지해 사진처럼", image=f"data:image/png;base64,{encoded}")
    result = web.nano_banana_render(request, _RequestStub())

    assert result["image"] == f"data:image/png;base64,{encoded}"
    assert captured["json"]["model"] == "gemini-3.1-flash-image"
    assert captured["json"]["store"] is False
    assert captured["json"]["input"][1]["data"] == encoded
    assert captured["headers"]["x-goog-api-key"] == "test-key"
