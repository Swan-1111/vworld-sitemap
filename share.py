"""친구에게 줄 주소 만들기 — 내 컴퓨터에서 돌고 있는 화면을 인터넷으로 연다.

    python share.py

친구는 아무것도 깔지 않고 브라우저로 들어와 그대로 씁니다.
분석·다운로드·다이어그램 전부 됩니다. **내 컴퓨터가 하는 일**이기 때문입니다.

주의
  · 이 창을 닫으면 주소가 죽습니다. 내 컴퓨터가 켜져 있어야 합니다.
  · 인증키는 내 것을 씁니다. 친구가 분석하면 **내 하루 한도(1,000건)** 가 줄어듭니다.
  · 그래서 암호를 걸고 엽니다. 주소와 암호를 아는 사람만 들어옵니다.
"""

from __future__ import annotations

import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 8000))


BIN = os.path.join(HERE, "cache", "bin")
EXE_URL = ("https://github.com/cloudflare/cloudflared/releases/latest/download/"
           "cloudflared-windows-amd64.exe")


def verified_cloudflare_signature(path: str) -> bool:
    """자동으로 받은 EXE는 Cloudflare의 유효한 Authenticode 서명만 허용한다."""
    shell = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
    if not shell:
        return False
    literal = os.path.abspath(path).replace("'", "''")
    script = (
        f"$signature=Get-AuthenticodeSignature -LiteralPath '{literal}';"
        "if($signature.Status -ne 'Valid'){exit 2};"
        "$subject=$signature.SignerCertificate.Subject;"
        "if($subject -notmatch 'Cloudflare'){exit 3};"
        "Write-Output $subject"
    )
    try:
        checked = subprocess.run(
            [shell, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return checked.returncode == 0


def find_cloudflared() -> str | None:
    """cloudflared 를 찾는다. 없으면 실행파일 하나만 받아서 쓴다.

    winget 의 MSI 는 관리자 권한을 요구해서 그냥 취소된다(1602).
    cloudflared 는 설치가 필요 없는 단일 exe 로도 배포되므로 그걸 받는다.
    """
    p = shutil.which("cloudflared")
    if p:
        return p
    for base in (os.environ.get("LOCALAPPDATA", ""), os.environ.get("ProgramFiles", ""),
                 os.environ.get("ProgramFiles(x86)", "")):
        if base:
            cand = os.path.join(base, "cloudflared", "cloudflared.exe")
            if os.path.isfile(cand):
                return cand

    local = os.path.join(BIN, "cloudflared.exe")
    if os.path.isfile(local):
        if verified_cloudflare_signature(local):
            return local
        print("  cache/bin/cloudflared.exe의 Cloudflare 서명을 확인하지 못해 사용하지 않습니다.")

    print("\n  cloudflared 가 없습니다. 실행파일 하나만 받습니다 (약 60MB, 최초 1회)")
    print("  설치는 하지 않습니다 — cache/bin/ 에 파일 하나로 둡니다.\n")
    try:
        import urllib.request
        os.makedirs(BIN, exist_ok=True)
        tmp = local + ".part"
        with urllib.request.urlopen(EXE_URL, timeout=300) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while chunk := r.read(1 << 20):
                f.write(chunk)
                got += len(chunk)
                if total:
                    print(f"\r    {got / total * 100:5.1f}%  {got / 1048576:.0f}MB",
                          end="", flush=True)
        if not verified_cloudflare_signature(tmp):
            raise RuntimeError("받은 cloudflared.exe의 Cloudflare 디지털 서명이 유효하지 않습니다.")
        os.replace(tmp, local)
        print("\n    받았습니다.\n")
        return local
    except Exception as e:
        print(f"\n  받지 못했습니다: {e}")
        return None


def make_password() -> str:
    """읽어 주기 쉬운 암호. 헷갈리는 글자(0/O, 1/l)는 뺀다."""
    pool = "".join(c for c in string.ascii_lowercase + string.digits if c not in "0o1li")
    return "-".join("".join(secrets.choice(pool) for _ in range(4)) for _ in range(3))


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except Exception:
                pass

    exe = find_cloudflared()
    if not exe:
        print("\n  cloudflared 를 준비하지 못했습니다.")
        print("  인터넷이 막혀 있다면 아래 주소에서 직접 받아")
        print(f"  {BIN}\\cloudflared.exe 로 두세요.\n")
        print(f"      {EXE_URL}\n")
        return

    password = os.environ.get("ACCESS_PASSWORD", "").strip() or make_password()
    env = {**os.environ, "ACCESS_PASSWORD": password, "PORT": str(PORT)}

    print(f"\n  ① 서버를 켭니다 (127.0.0.1:{PORT})")
    server = subprocess.Popen([sys.executable, "-u", "web.py"], cwd=HERE, env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(3)

    print("  ② 인터넷 주소를 엽니다 …\n")
    tunnel = subprocess.Popen(
        [exe, "tunnel", "--url", f"http://127.0.0.1:{PORT}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace",
    )

    url_seen = threading.Event()

    def watch():
        for line in tunnel.stdout:
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
            if m and not url_seen.is_set():
                url_seen.set()
                print("=" * 62, flush=True)
                print("  친구에게 이 둘을 보내세요")
                print()
                print(f"    주소 : {m.group(0)}")
                print(f"    암호 : {password}")
                print()
                print("  아이디 칸은 비워도 됩니다. 암호만 맞으면 들어옵니다.")
                print("=" * 62, flush=True)
                print("\n  이 창을 닫으면 주소가 죽습니다. 끝내려면 Ctrl+C.\n")

    threading.Thread(target=watch, daemon=True).start()

    try:
        tunnel.wait()
    except KeyboardInterrupt:
        pass
    finally:
        for p in (tunnel, server):
            try:
                p.terminate()
            except Exception:
                pass
        print("\n  주소를 닫았습니다.")


if __name__ == "__main__":
    main()
