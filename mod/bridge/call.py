#!/usr/bin/env python3
"""One Claude-in-Chrome tool call over the local native-messaging bridge.

stdin:  {"tool": "...", "args": {...}, "socket": optional path}
stdout: {"socket": path, "result": {...}} or {"socket": path, "error": ...}

The bridge is /tmp/claude-mcp-browser-bridge-$USER/<pid>.sock, one per native host (one per
Chrome profile with the extension). Frames are a 4-byte little-endian length, then UTF-8 JSON.
The extension still applies its own site permissions, blocklists and tab-group limit.
Without "socket", each socket of the chosen browser ("browser", default Comet) is tried in turn.
"""
import glob, json, os, socket, struct, subprocess, sys, time, uuid

def call(path, tool, args, timeout):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(path)
    tid = str(uuid.uuid4())
    body = json.dumps({"method": "execute_tool", "params": {"client_id": "claude-code", "tool": tool, "args": args, "tool_use_id": tid}}).encode()
    s.sendall(struct.pack("<I", len(body)) + body)
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        chunk = s.recv(1 << 20)
        if not chunk:
            break
        buf += chunk
        while len(buf) >= 4:
            n = struct.unpack("<I", buf[:4])[0]
            if len(buf) < 4 + n:
                break
            msg = json.loads(buf[4:4 + n])
            buf = buf[4 + n:]
            # responses go to every client on the socket: keep only ours
            if msg.get("tool_use_id") == tid:
                s.close()
                return msg
    s.close()
    raise TimeoutError(f"no reply from {path} in {timeout}s")

def browser_of(path):
    """The browser that started the native host behind a socket (the file name is the host pid)."""
    try:
        pid = int(os.path.basename(path).split(".")[0])
        ppid = subprocess.run(["ps", "-o", "ppid=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        return subprocess.run(["ps", "-o", "comm=", "-p", ppid], capture_output=True, text=True).stdout.strip()
    except Exception:
        return ""

def main():
    req = json.load(sys.stdin)
    timeout = float(req.get("timeout", 20))
    if req.get("socket"):
        paths = [req["socket"]]
    else:
        paths = sorted(glob.glob(f"/tmp/claude-mcp-browser-bridge-{os.environ.get('USER', '')}/*.sock"))
        # Only the chosen browser's host (Comet by default): never fall through to another browser.
        want = req.get("browser", "Comet").lower()
        paths = [p for p in paths if want in browser_of(p).lower()]
    last = {"error": f"no bridge socket for {req.get('browser', 'Comet')}"}
    for p in paths:
        try:
            msg = call(p, req["tool"], req.get("args", {}), timeout)
        except Exception as e:  # a dead socket from an old host: try the next one
            last = {"socket": p, "error": f"{type(e).__name__}: {e}"}
            continue
        out = {"socket": p, **{k: v for k, v in msg.items() if k in ("result", "error")}}
        if "result" in msg:
            print(json.dumps(out))
            return
        last = out
    print(json.dumps(last))

main()
