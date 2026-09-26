"""장면 폴리곤과 지반 표본점 회귀 검사."""

from __future__ import annotations

from shapely.geometry import Polygon

import scene


def test_polygon_groups_keep_interior_rings():
    polygon = Polygon(
        [(0, 0), (20, 0), (20, 20), (0, 20), (0, 0)],
        holes=[[(5, 5), (15, 5), (15, 15), (5, 15), (5, 5)]],
    )
    groups = scene._polygon_groups(polygon)
    assert len(groups) == 1
    assert len(groups[0]) == 2


def test_with_ground_uses_representative_point_instead_of_vertex_average():
    item = {
        "rings": [[[-9, -9], [1, -9], [1, 1], [-9, 1], [-9, -9]]],
        "base_point": [8, 8],
    }
    data = {
        "radius": 10,
        "spots": [[-10, -10, 0], [10, -10, 10], [-10, 10, 10], [10, 10, 20]],
        "contours": [], "pad": [], "buildings": [item], "parcels": [],
    }
    built = scene.with_ground(data, 20)
    assert built["buildings"][0]["base"] > 16
