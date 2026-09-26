"""브이월드(V-World) 오픈API 클라이언트.

공식 레퍼런스
  - 데이터 API 2.0 : https://www.vworld.kr/dev/v4dv_2ddataguide2_s001.do
  - 검색   API 2.0 : https://www.vworld.kr/dev/v4dv_search2_s001.do
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time

import requests

from common import network_session

DATA_URL = "https://api.vworld.kr/req/data"
SEARCH_URL = "https://api.vworld.kr/req/search"
ADDRESS_URL = "https://api.vworld.kr/req/address"

# 응답이 비었을 때 브이월드가 돌려주는 상태값. 오류가 아니라 "결과 0건"이다.
EMPTY_STATUSES = {"NOT_FOUND", "EMPTY"}


class VWorldError(RuntimeError):
    pass


def load_key(env_path: str | None = None) -> tuple[str, str]:
    """인증키와 등록 도메인을 읽는다.

    **환경변수가 .env 를 이긴다.** 웹에서 각자 자기 키를 넣어 쓸 수 있어야 하는데,
    반대로 두면 서버 주인의 .env 가 항상 이겨서 남의 키가 무시된다.
    """
    key = domain = ""
    if env_path and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                value = value.strip().strip('"').strip("'")
                if name.strip() == "VWORLD_KEY" and value:
                    key = value
                elif name.strip() == "VWORLD_DOMAIN" and value:
                    domain = value

    key = os.environ.get("VWORLD_KEY") or key
    domain = os.environ.get("VWORLD_DOMAIN") or domain or "http://localhost"

    if not key:
        raise VWorldError(
            "브이월드 인증키가 없습니다. tools/vworld/.env 파일에 VWORLD_KEY=... 를 넣어주세요.\n"
            "발급 방법은 tools/vworld/README.md 참고."
        )
    return key, domain


class VWorld:
    def __init__(self, key: str, domain: str = "http://localhost", pause: float = 0.12):
        self.key = key
        self.domain = domain
        self.pause = pause  # 연속 호출 시 서버 부담을 줄이는 간격(초)
        self.session = network_session()

    def _request(self, url: str, params: dict, timeout: int):
        try:
            response = self.session.get(url, params=params, timeout=timeout)
            response.raise_for_status()
            return response
        except requests.exceptions.ProxyError as exc:
            raise VWorldError(
                "브이월드 연결에 실패했습니다. Windows 또는 실행 환경의 프록시 설정을 확인하세요."
            ) from exc
        except requests.Timeout as exc:
            raise VWorldError("브이월드 서버 응답 시간이 초과됐습니다. 잠시 후 다시 시도하세요.") from exc
        except requests.RequestException as exc:
            # requests 예외 문자열에는 인증키가 든 전체 URL이 포함될 수 있다.
            raise VWorldError(
                f"브이월드 서버에 연결하지 못했습니다 ({type(exc).__name__})."
            ) from exc

    # ------------------------------------------------------------------ 검색

    def search_address(self, query: str, category: str = "PARCEL") -> dict:
        """지번주소 → 좌표(EPSG:4326). category: PARCEL(지번) | ROAD(도로명)"""
        params = {
            "service": "search",
            "request": "search",
            "version": "2.0",
            "query": query,
            "type": "ADDRESS",
            "category": category,
            "format": "json",
            "crs": "EPSG:4326",
            "size": 10,
            "key": self.key,
        }
        res = self._request(SEARCH_URL, params, 30)
        body = res.json()["response"]
        status = body.get("status")
        if status in EMPTY_STATUSES:
            raise VWorldError(f"주소를 찾지 못했습니다: {query}")
        if status != "OK":
            raise VWorldError(f"검색 API 오류: {json.dumps(body, ensure_ascii=False)[:400]}")

        item = body["result"]["items"][0]
        point = item["point"]
        return {
            "lon": float(point["x"]),
            "lat": float(point["y"]),
            "address": item.get("address", {}).get("parcel") or item.get("title"),
            "id": item.get("id"),
        }

    def reverse_geocode(self, lon: float, lat: float) -> str | None:
        """좌표 → 지번주소. 지도에서 영역만 끌었을 때 대상지 이름을 붙이는 데 쓴다."""
        params = {
            "service": "address",
            "request": "getAddress",
            "version": "2.0",
            "crs": "epsg:4326",
            "point": f"{lon},{lat}",
            "format": "json",
            "type": "PARCEL",
            "key": self.key,
        }
        try:
            res = self.session.get(ADDRESS_URL, params=params, timeout=30)
            res.raise_for_status()
            body = res.json()["response"]
            if body.get("status") != "OK":
                return None
            return body["result"][0].get("text")
        except (requests.RequestException, ValueError, KeyError, IndexError):
            return None  # 이름 짓기용이라 실패해도 진행에 지장이 없다

    # ------------------------------------------------------------- 데이터API

    def _get_feature_page(self, data_id: str, bbox, page: int, size: int) -> dict:
        minx, miny, maxx, maxy = bbox
        params = {
            "service": "data",
            "version": "2.0",
            "request": "GetFeature",
            "format": "json",
            "data": data_id,
            "geomFilter": f"BOX({minx},{miny},{maxx},{maxy})",
            "crs": "EPSG:4326",
            "size": size,
            "page": page,
            "geometry": "true",
            "attribute": "true",
            "key": self.key,
            "domain": self.domain,
        }
        res = self._request(DATA_URL, params, 60)
        try:
            return res.json()["response"]
        except (ValueError, KeyError):
            raise VWorldError(
                f"[{data_id}] 응답을 해석할 수 없습니다. 인증키/도메인 설정을 확인하세요.\n"
                f"응답 앞부분: {res.text[:300]}"
            )

    def get_feature(self, data_id: str, bbox, size: int = 1000, max_pages: int = 50) -> list[dict]:
        """한 bbox에 대해 모든 페이지를 돌며 GeoJSON feature 목록을 반환."""
        features: list[dict] = []
        page = 1
        while page <= max_pages:
            body = self._get_feature_page(data_id, bbox, page, size)
            status = body.get("status")
            if status in EMPTY_STATUSES:
                break
            if status != "OK":
                err = body.get("error", {})
                raise VWorldError(
                    f"[{data_id}] 데이터API 오류 {err.get('code', status)}: {err.get('text', body)}"
                )

            page_features = body["result"]["featureCollection"]["features"]
            features.extend(page_features)

            total_pages = int(body.get("page", {}).get("total", 1) or 1)
            if page >= total_pages or not page_features:
                break
            page += 1
            time.sleep(self.pause)
        return features

    def get_feature_tiled(
        self,
        data_id: str,
        bbox,
        cell_deg: float = 0.004,
        size: int = 1000,
        on_progress=None,
    ) -> list[dict]:
        """bbox를 격자로 쪼개 수집한다.

        브이월드는 한 요청이 커지면 누락되거나 실패하므로, 도심 밀집지역에서는
        작은 셀로 나눠 받은 뒤 중복을 제거하는 편이 안전하다.
        """
        minx, miny, maxx, maxy = bbox
        nx = max(1, math.ceil((maxx - minx) / cell_deg))
        ny = max(1, math.ceil((maxy - miny) / cell_deg))
        dx = (maxx - minx) / nx
        dy = (maxy - miny) / ny

        collected: dict[str, dict] = {}
        total_cells = nx * ny
        done = 0
        for i in range(nx):
            for j in range(ny):
                cell = (
                    minx + i * dx,
                    miny + j * dy,
                    minx + (i + 1) * dx,
                    miny + (j + 1) * dy,
                )
                for feat in self.get_feature(data_id, cell, size=size):
                    collected[_feature_key(feat)] = feat
                done += 1
                if on_progress:
                    on_progress(done, total_cells, len(collected))
                time.sleep(self.pause)
        return list(collected.values())


def _feature_key(feature: dict) -> str:
    """중복 제거용 키. 고유 식별자가 있으면 쓰고, 없으면 지오메트리 해시."""
    props = feature.get("properties") or {}
    for field in ("pnu", "bd_mgt_sn", "id", "uid", "ufid"):
        value = props.get(field)
        if value:
            return f"{field}:{value}"
    if feature.get("id"):
        return f"fid:{feature['id']}"
    blob = json.dumps(feature.get("geometry"), sort_keys=True).encode()
    return "geom:" + hashlib.md5(blob).hexdigest()


def bbox_from_center(lon: float, lat: float, radius_m: float) -> tuple[float, float, float, float]:
    """중심좌표(경위도)와 반경(m)으로 정사각형 bbox를 만든다."""
    dlat = radius_m / 111_320.0
    dlon = radius_m / (111_320.0 * math.cos(math.radians(lat)))
    return (lon - dlon, lat - dlat, lon + dlon, lat + dlat)
