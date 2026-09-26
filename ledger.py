"""건축물대장(표제부) API 클라이언트 — 공공데이터포털 건축HUB.

레퍼런스: https://www.data.go.kr/data/15134735/openapi.do

필지 하나씩 조회하면 호출 수가 필지 수만큼 늘어난다. bun/ji는 선택 파라미터이므로
**법정동 단위로 한 번에** 받아서 로컬에서 PNU로 조인하는 편이 훨씬 싸고 빠르다.
(개발계정 트래픽 한도가 하루 1,000건이라 이 차이가 크다.)
"""

from __future__ import annotations

import os
import time
from urllib.parse import unquote

import requests

from common import network_session

DEFAULT_ENDPOINT = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"


class LedgerError(RuntimeError):
    pass


def load_key(env_path: str | None = None) -> tuple[str, str]:
    """공공데이터포털 서비스키와 엔드포인트를 읽는다."""
    # 환경변수가 .env 를 이긴다 — 각자 자기 키를 넣어 쓸 수 있어야 한다.
    key = endpoint = ""
    if env_path and os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                value = value.strip().strip('"').strip("'")
                if name.strip() == "DATA_GO_KR_KEY" and value:
                    key = value
                elif name.strip() == "LEDGER_ENDPOINT" and value:
                    endpoint = value

    key = os.environ.get("DATA_GO_KR_KEY") or key
    endpoint = os.environ.get("LEDGER_ENDPOINT") or endpoint or DEFAULT_ENDPOINT

    if not key:
        raise LedgerError(
            "공공데이터포털 서비스키가 없습니다. tools/vworld/.env 에 DATA_GO_KR_KEY=... 를 넣어주세요.\n"
            "※ 포털에서 주는 두 가지 키 중 **일반 인증키(Decoding)** 를 넣으세요."
        )

    # Encoding 키(%2B·%2F·%3D 포함)를 넣었으면 풀어준다.
    # requests가 파라미터를 다시 인코딩하므로 그대로 두면 이중 인코딩으로 인증이 깨진다.
    if "%" in key:
        key = unquote(key)
    return key, endpoint


# PNU 11번째 자리(필지구분)와 대장 platGbCd는 부호 체계가 다르다.
#   PNU : 1=일반(토지),  2=산(임야)
#   대장 : 0=대지,       1=산,        2=블록
_PNU_TO_PLATGB = {"1": "0", "2": "1"}
_PLATGB_TO_PNU = {"0": "1", "1": "2", "2": "1"}


def split_pnu(pnu: str) -> dict:
    """PNU 19자리를 건축물대장 조회 파라미터로 분해."""
    pnu = str(pnu).strip()
    if len(pnu) != 19 or not pnu.isdigit():
        raise ValueError(f"PNU 형식이 아닙니다: {pnu!r}")
    return {
        "sigunguCd": pnu[0:5],
        "bjdongCd": pnu[5:10],
        "platGbCd": _PNU_TO_PLATGB.get(pnu[10], "0"),
        "bun": pnu[11:15],
        "ji": pnu[15:19],
    }


def make_pnu(item: dict) -> str | None:
    """건축물대장 한 건에서 PNU 19자리를 복원."""
    try:
        sigungu = str(item["sigunguCd"]).zfill(5)
        bjdong = str(item["bjdongCd"]).zfill(5)
        plat_gb = _PLATGB_TO_PNU.get(str(item.get("platGbCd", "0")), "1")
        bun = str(item.get("bun", "")).zfill(4)
        ji = str(item.get("ji", "")).zfill(4)
    except (KeyError, TypeError):
        return None
    pnu = f"{sigungu}{bjdong}{plat_gb}{bun}{ji}"
    return pnu if len(pnu) == 19 else None


class Ledger:
    def __init__(self, key: str, endpoint: str = DEFAULT_ENDPOINT, pause: float = 0.15):
        self.key = key
        self.endpoint = endpoint
        self.pause = pause
        self.session = network_session()

    # 되돌릴 수 없는 오류. 이게 보이면 재시도해도 소용없다.
    FATAL = (
        ("SERVICE_KEY_IS_NOT_REGISTERED", "서비스키가 등록되지 않았습니다. .env 의 DATA_GO_KR_KEY 를 확인하세요."),
        ("SERVICE_ACCESS_DENIED", "이 서비스에 대한 활용신청이 승인되지 않았습니다."),
        ("LIMITED_NUMBER_OF_SERVICE_REQUESTS", "오늘 트래픽 한도를 넘었습니다 (개발계정 1,000건/일). 내일 다시 받거나 운영계정으로 신청하세요."),
        ("DEADLINE_HAS_EXPIRED", "서비스 활용기간이 끝났습니다."),
        ("UNREGISTERED_IP", "신청한 IP 가 아닙니다."),
    )

    def _get(self, params: dict, tries: int = 4) -> dict:
        """한 페이지를 받는다.

        공공데이터포털은 멀쩡히 돌다가도 빈 응답이나 502 를 간헐적으로 준다.
        한 번 걸렸다고 수집 전체를 버리면 이미 받은 수백 건이 같이 날아간다.
        되돌릴 수 없는 오류(키·트래픽)만 즉시 포기하고, 나머지는 쉬었다 다시 친다.
        """
        last = ""
        for attempt in range(1, tries + 1):
            try:
                res = self.session.get(self.endpoint, params=params, timeout=60)
                if res.status_code >= 500:
                    last = f"HTTP {res.status_code}"
                else:
                    res.raise_for_status()
                    text = res.text or ""
                    for token, why in self.FATAL:
                        if token in text:
                            raise LedgerError(f"건축물대장 API — {why}")
                    if not text.strip():
                        last = "빈 응답"
                    else:
                        try:
                            return res.json()["response"]
                        except (ValueError, KeyError):
                            last = f"해석 불가: {text[:200]}"
            except requests.RequestException as e:
                last = f"{type(e).__name__}: {e}"

            if attempt < tries:
                wait = 2 ** attempt          # 2, 4, 8초
                print(f"\n  · 재시도 {attempt}/{tries - 1} ({last}) — {wait}초 후",
                      flush=True)
                time.sleep(wait)

        raise LedgerError(
            f"건축물대장 응답을 {tries}번 시도했지만 받지 못했습니다 ({last}).\n"
            f"엔드포인트: {self.endpoint}"
        )

    def fetch_dong(
        self,
        sigungu_cd: str,
        bjdong_cd: str,
        rows: int = 1000,
        max_pages: int = 2000,
        on_progress=None,
        on_partial=None,
        initial_items: list[dict] | None = None,
        start_page: int = 1,
    ) -> list[dict]:
        """법정동(시군구+읍면동) 단위로 표제부 전체를 받아온다.

        numOfRows를 크게 줘도 서버가 100건씩만 돌려주는 경우가 있다. 그래서 페이지 상한을
        고정으로 두면 조용히 잘린다. totalCount에 도달할 때까지 돈다.
        """
        items: list[dict] = list(initial_items or [])
        page = max(1, int(start_page))
        while page <= max_pages:
            params = {
                "serviceKey": self.key,
                "sigunguCd": sigungu_cd,
                "bjdongCd": bjdong_cd,
                "numOfRows": rows,
                "pageNo": page,
                "_type": "json",
            }
            try:
                body = self._get(params)
            except LedgerError:
                # 여기서 그냥 죽으면 이미 받은 수백 건이 같이 날아간다
                if on_partial and items:
                    on_partial(items, page)
                raise

            header = body.get("header", {})
            if header.get("resultCode") not in ("00", "0", None):
                raise LedgerError(
                    f"건축물대장 API 오류 {header.get('resultCode')}: {header.get('resultMsg')}"
                )

            payload = body.get("body") or {}
            raw = (payload.get("items") or {}).get("item") or []
            if isinstance(raw, dict):  # 1건이면 리스트가 아니라 객체로 온다
                raw = [raw]
            items.extend(raw)

            total = int(payload.get("totalCount") or 0)
            if on_progress:
                on_progress(len(items), total)
            if not raw or len(items) >= total:
                break
            page += 1
            time.sleep(self.pause)
        else:
            raise LedgerError(
                f"{sigungu_cd}-{bjdong_cd}: 페이지 상한({max_pages})에 걸렸습니다. "
                f"{len(items)}건만 받았습니다."
            )
        return items
