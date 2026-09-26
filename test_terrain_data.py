"""전국 NGII DEM 캐시의 합성 GeoTIFF 회귀 검사."""

from __future__ import annotations

import importlib
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.transform import from_bounds
from shapely.geometry import box


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


class TerrainDataTest(unittest.TestCase):
    def setUp(self):
        # GDAL의 Windows 드라이버도 샌드박스 안에서 쓸 수 있도록 작업공간에 만든다.
        self.temp = tempfile.TemporaryDirectory(dir=HERE)
        os.environ["VWORLD_TERRAIN_CACHE"] = str(Path(self.temp.name) / "terrain")
        import terrain_data
        self.data = importlib.reload(terrain_data)
        self.to_tm = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
        self.cx, self.cy = self.to_tm.transform(127.0, 37.5)

    def tearDown(self):
        self.temp.cleanup()
        os.environ.pop("VWORLD_TERRAIN_CACHE", None)

    def make_dem(self, name: str, bounds, offset: float = 0.0) -> Path:
        path = Path(self.temp.name) / name
        height = width = 64
        rows, cols = np.mgrid[0:height, 0:width]
        values = (40.0 + offset + rows * 0.45 + cols * 0.25).astype("float32")
        with rasterio.open(
            path, "w", driver="HFA" if path.suffix.lower() == ".img" else "GTiff",
            width=width, height=height, count=1,
            dtype="float32", crs="EPSG:5186",
            transform=from_bounds(*bounds, width, height), nodata=-9999.0,
        ) as dst:
            dst.write(values, 1)
        return path

    def test_import_version_bbox_sample_and_contour(self):
        bounds = (self.cx - 600, self.cy - 600, self.cx + 600, self.cy + 600)
        first = self.make_dem("ngii-a.tif", bounds)
        installed = self.data.import_source(str(first))
        self.assertEqual(installed["added"], 1)
        self.assertEqual(self.data.status()["tiles"], 1)

        grid, source = self.data.sample_grid("EPSG:5186", bounds, 41)
        self.assertIsNotNone(grid)
        self.assertGreater(np.isfinite(grid).sum(), 1500)
        self.assertEqual(source["kind"], "ngii-dem")

        terrain = self.data.scene_terrain(
            "EPSG:5186", self.cx, self.cy, box(-450, -450, 450, 450), 0.2)
        self.assertIsNotNone(terrain)
        spots, contours, samples, terrain_source = terrain
        self.assertEqual(spots, [])
        self.assertGreater(len(contours), 2)
        self.assertGreater(len(samples), 100)
        self.assertEqual(terrain_source["kind"], "ngii-dem")

        import scene
        integrated = scene._terrain(None, "EPSG:5186", self.cx, self.cy,
                                    box(-450, -450, 450, 450))
        self.assertEqual(integrated[3]["kind"], "ngii-dem")
        built = scene.with_ground({
            "radius": 450, "spots": integrated[0], "contours": integrated[1],
            "pad": integrated[2], "parcels": [], "buildings": [],
        }, 40)
        self.assertEqual(built["ground"]["n"], 40)
        self.assertGreater(built["ground"]["max"], built["ground"]["min"])

        import terrain as terrain_module
        output = Path(self.temp.name) / "site-output"
        output.mkdir()
        dummy_site = SimpleNamespace(
            dir=str(output), dxf_terrain=str(output / "terrain.dxf"),
            csv_spot=str(output / "spots.csv"),
        )
        dummy_frame = SimpleNamespace(
            ox=self.cx, oy=self.cy, crs="EPSG:5186", crs_label="중부원점",
        )
        terrain_module._write_dem(dummy_site, dummy_frame,
                                  box(-450, -450, 450, 450), terrain, False)
        self.assertTrue(Path(dummy_site.dxf_terrain).exists())
        self.assertTrue(Path(dummy_site.csv_spot).exists())
        self.assertTrue((output / "지형_출처.txt").exists())

        # 새 도엽을 넣어도 예전 버전 파일을 지우지 않고 현재 색인에 누적한다.
        second_bounds = (self.cx + 600, self.cy - 600, self.cx + 1800, self.cy + 600)
        second = self.make_dem("ngii-b.img", second_bounds, 20.0)
        updated = self.data.import_source(str(second))
        self.assertEqual(len(updated["files"]), 2)
        self.assertTrue(first.exists())
        self.assertEqual(self.data.status()["tiles"], 2)

        # 웹은 multipart 없이 원본 본문을 스트리밍해 대형 파일도 메모리에 올리지 않는다.
        import web
        third_bounds = (self.cx - 600, self.cy + 600, self.cx + 600, self.cy + 1800)
        third = self.make_dem("ngii-web.tif", third_bounds, 40.0)
        payload = third.read_bytes()

        class RawRequest:
            async def stream(self):
                for start in range(0, len(payload), 4096):
                    yield payload[start:start + 4096]

        response = asyncio.run(web.import_terrain_data(RawRequest(), "ngii-web.tif"))
        self.assertEqual(response["added"], 1)
        self.assertEqual(response["tiles"], 3)


if __name__ == "__main__":
    unittest.main()
