"""작업 폴더 경계와 명령행 인자 회귀 검사."""

from __future__ import annotations

import os

import pytest

from common import OUT_ROOT, Site, slugify
from fetch_site import parse_args


def test_site_names_never_escape_out_root():
    root = os.path.abspath(OUT_ROOT)
    for raw in ("../outside", r"..\outside", "CON", "LPT1.txt"):
        site = Site(raw)
        target = os.path.abspath(site.dir)
        assert target != root
        assert os.path.commonpath((root, target)) == root

    for raw in (".", "..", "...", " . . "):
        with pytest.raises(ValueError):
            Site(raw)


def test_windows_reserved_names_are_rewritten():
    assert slugify("CON") == "CON-site"
    assert slugify("lpt1.txt") == "lpt1.txt-site"
    assert slugify("대상지.") == "대상지"


def test_fetch_site_parser_accepts_library_arguments():
    args = parse_args(["서울특별시 종로구 세종로", "--radius", "420", "--name", "검사"])
    assert args.address == "서울특별시 종로구 세종로"
    assert args.radius == 420
    assert args.name == "검사"
