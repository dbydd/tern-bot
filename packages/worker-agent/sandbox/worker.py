#!/usr/bin/env python3
"""tern-bot worker resident: one agent CLI process behind a reattachable ACP gateway.

Modes
-----
launch
    Start ``serve`` as a detached process in a new session, wait until the
    resident has finished bootstrap (agent initialized, session created), and
    print one JSON receipt on stdout. Exits leaving the daemon running.
serve
    The resident itself. Owns the agent child process (stdin/stdout ACP,
    stderr to ``agent-stderr.log``), owns the single logical session, journals
    every ``session/update`` to ``events.jsonl``, and listens on
    ``<stateDir>/control.sock``.
connect
    Relay the caller's stdin/stdout to the socket. Stdin EOF closes only this
    attachment; the resident and the agent keep running.
request
    Send one control request (``tern-bot/status``, ``tern-bot/prompt``,
    ``tern-bot/stop``) and print the JSON result or error.

Wire format
-----------
Newline-delimited JSON-RPC 2.0 in both directions. A frontend is a connection
that sends ``initialize`` (or the ``tern-bot/attach`` notification that the
``connect`` relay sends first). Only the most recently attached frontend holds
control; a newer frontend detaches the older one. Incoming requests are
remapped to resident-scoped ids before they reach the agent, and responses are
mapped back, so frontend id spaces never collide with the resident's own
requests. ``session/update`` frames from the agent are stored verbatim and
replayed in order to a new frontend before live delivery starts.

Control methods (any connection)
--------------------------------
``tern-bot/status``
    Return the resident status object (same fields as ``status.json``).
``tern-bot/prompt`` ``{text}``
    Submit a text prompt to the resident session; the result says the frame
    was submitted, and the agent's outcome is journalled plus kept in
    ``status.lastPrompt``.
``tern-bot/stop``
    Terminate the agent and the resident (the only explicit teardown).
``tern-bot/attach``
    Claim frontend control for the connection (the ``connect`` relay sends it
    first).

``session/cancel`` is forwarded only when the active turn was submitted by a
frontend ``session/prompt`` and the sender is the controlling frontend; a
cancel for a control/bot-submitted turn is swallowed and journalled. A
frontend disconnect never forwards cancel, ``session/close`` or shutdown.

State files
-----------
``status.json``
    pid, agentPid, sessionId, phase (starting/working/idle/waiting_input/
    failed/exited), error, pendingFrontendPermissionCount, activePromptOrigin,
    lastPrompt, authMethods, cwd, socket, startedAt, updatedAt.
``events.jsonl``
    Append-only journal. ``session/update`` frames exactly as the agent sent
    them, plus ``tern-bot/journal`` records for resident decisions (prompt
    submission/result, cancel forwarding or swallowing, frontend
    attach/detach, agent exit). Replay ignores everything but
    ``session/update`` for the resident session.
``resident.log``
    Resident stdout/stderr (the launch redirect) and the child's stderr are
    kept separate: ``agent-stderr.log``.

The resident never grants permissions itself, never restarts a dead agent, and
never synthesizes a protocol response. Unsupported client request kinds
(filesystem, terminal, elicitation) are answered with method-not-found because
the resident does not advertise those client capabilities.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

PROTOCOL_VERSION = 1
WORKER_VERSION = "0.1.0"
DEFAULT_STATE_DIR = "/tmp/tern-bot-worker"
BOOTSTRAP_TIMEOUT = 120.0
STOP_GRACE = 5.0
MAX_FRAME_BYTES = 64 * 1024 * 1024
LAUNCH_READY_TIMEOUT = BOOTSTRAP_TIMEOUT + 30.0
UNIX_SOCKET_PATH_LIMIT = 100

_MISSING = object()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _log(message: str) -> None:
    sys.stderr.write(f"[{_now()}] {message}\n")
    sys.stderr.flush()


def _encode(message: dict) -> bytes:
    return json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _frame(message: dict) -> bytes:
    return _encode(message) + b"\n"


class WorkerError(Exception):
    """Base class for resident failures."""


class ConfigError(WorkerError):
    """The persisted configuration is invalid."""


class ResidentAlreadyRunning(WorkerError):
    """Another resident owns the control socket."""


class FrameTooLarge(WorkerError):
    """A peer sent a JSON-RPC frame larger than the reader accepts."""


class ProtocolError(WorkerError):
    """The agent answered outside the ACP shape the resident needs."""


class JsonRpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = _MISSING):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_error(self) -> dict:
        error = {"code": self.code, "message": self.message}
        if self.data is not _MISSING:
            error["data"] = self.data
        return error


def _invalid_params(message: str, data: Any = _MISSING) -> JsonRpcError:
    return JsonRpcError(-32602, f"Invalid params: {message}", data)


def _method_not_found(method: str) -> JsonRpcError:
    return JsonRpcError(-32601, f'"Method not found": {method}', {"method": method})


def _internal_error(message: str, data: Any = _MISSING) -> JsonRpcError:
    return JsonRpcError(-32603, f"Internal error: {message}", data)


@dataclass(frozen=True)
class Config:
    command: list
    cwd: str
    prompt: str
    state_dir: str
    env: dict
    config_path: Optional[str] = None


@dataclass(frozen=True)
class Paths:
    state_dir: str
    socket: str
    status: str
    journal: str
    resident_log: str
    agent_stderr: str


def paths_for(state_dir: str) -> Paths:
    return Paths(
        state_dir=state_dir,
        socket=os.path.join(state_dir, "control.sock"),
        status=os.path.join(state_dir, "status.json"),
        journal=os.path.join(state_dir, "events.jsonl"),
        resident_log=os.path.join(state_dir, "resident.log"),
        agent_stderr=os.path.join(state_dir, "agent-stderr.log"),
    )


def _require_absolute(label: str, value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ConfigError(f"{label} must be a non-empty string")
    if not os.path.isabs(value):
        raise ConfigError(f"{label} must be an absolute path: {value!r}")
    return value


def load_config(path: str) -> Config:
    """Read and validate the persisted bootstrap config as external input."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        raise ConfigError(f"config file not found: {path}")
    except OSError as exc:
        raise ConfigError(f"cannot read config {path}: {exc}")
    except json.JSONDecodeError as exc:
        raise ConfigError(f"config {path} is not valid JSON: {exc}")
    if not isinstance(raw, dict):
        raise ConfigError("config must be a JSON object")

    known = {"command", "cwd", "prompt", "stateDir", "env"}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ConfigError(f"unknown config field(s): {', '.join(unknown)}")

    command = raw.get("command")
    if not isinstance(command, list) or not command:
        raise ConfigError("command must be a non-empty array of strings")
    if not all(isinstance(part, str) and part for part in command):
        raise ConfigError("command must be a non-empty array of strings")

    cwd = _require_absolute("cwd", raw.get("cwd"))
    if not os.path.isdir(cwd):
        raise ConfigError(f"cwd does not exist or is not a directory: {cwd}")

    prompt = raw.get("prompt")
    if not isinstance(prompt, str):
        raise ConfigError("prompt must be a string (use \"\" for no initial task)")

    state_dir = raw.get("stateDir", DEFAULT_STATE_DIR)
    state_dir = _require_absolute("stateDir", state_dir)

    env = raw.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        raise ConfigError("env must be an object of string values")

    socket_path = os.path.join(state_dir, "control.sock")
    if len(os.fsencode(socket_path)) > UNIX_SOCKET_PATH_LIMIT:
        raise ConfigError(
            f"stateDir produces a socket path longer than {UNIX_SOCKET_PATH_LIMIT} bytes: {socket_path}"
        )

    return Config(
        command=list(command),
        cwd=cwd,
        prompt=prompt,
        state_dir=state_dir,
        env=dict(env),
        config_path=os.path.abspath(path),
    )


def ensure_state_dir(paths: Paths) -> None:
    os.makedirs(paths.state_dir, mode=0o700, exist_ok=True)


def read_status(paths: Paths) -> Optional[dict]:
    try:
        with open(paths.status, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def tail_text(path: str, limit: int = 4000) -> str:
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            data = handle.read()
    except OSError:
        return ""
    return data.decode("utf-8", errors="replace")


def socket_is_alive(path: str) -> bool:
    if not os.path.exists(path):
        return False
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.5)
    try:
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


def resolve_command(command: list, extra_env: dict) -> list:
    executable = command[0]
    if os.sep in executable:
        if not (os.path.isfile(executable) and os.access(executable, os.X_OK)):
            raise ConfigError(f"command is not an executable file: {executable}")
        return list(command)
    search_path = extra_env.get("PATH", os.environ.get("PATH", ""))
    found = shutil.which(executable, path=search_path)
    if not found:
        raise ConfigError(f"command not found in PATH: {executable}")
    return [found] + list(command[1:])


class LineFramer:
    """Read newline-delimited frames without imposing StreamReader's buffer limit."""

    def __init__(self, reader: asyncio.StreamReader, max_bytes: int = MAX_FRAME_BYTES):
        self._reader = reader
        self._buffer = b""
        self._max_bytes = max_bytes

    async def read_line(self) -> Optional[bytes]:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = self._buffer[:newline]
                self._buffer = self._buffer[newline + 1 :]
                return line
            if len(self._buffer) > self._max_bytes:
                raise FrameTooLarge(f"peer frame exceeds {self._max_bytes} bytes")
            chunk = await self._reader.read(65536)
            if not chunk:
                if self._buffer:
                    line = self._buffer
                    self._buffer = b""
                    return line
                return None
            self._buffer += chunk


class Journal:
    """Append-only byte journal; ``offset`` is the replayable prefix length."""

    def __init__(self, path: str):
        self._file = open(path, "ab", buffering=0)
        self._file.seek(0, os.SEEK_END)
        self.offset = self._file.tell()

    def append_raw(self, raw: bytes) -> None:
        data = raw + b"\n"
        self._file.write(data)
        self.offset += len(data)

    def close(self) -> None:
        try:
            self._file.close()
        except OSError:
            pass


@dataclass
class Outbound:
    """A request the resident wrote to the agent."""

    method: str
    future: Optional[asyncio.Future] = None
    conn: Optional["ClientConn"] = None
    frontend_id: Any = None
    origin: Optional[str] = None
    record: bool = False


@dataclass
class PendingClientRequest:
    """An agent request (permission) that a frontend must answer."""

    child_id: Any
    method: str
    params: Any
    gateway_id: Any = None
    offered_to: Optional["ClientConn"] = None


class ClientConn:
    def __init__(self, resident: "Resident", reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.resident = resident
        self.reader = reader
        self.writer = writer
        self.framer = LineFramer(reader)
        self.send_lock = asyncio.Lock()
        self.delivery_lock = asyncio.Lock()
        self.pending_server_ids: dict = {}
        self.outbound_ids: dict = {}
        self.is_frontend = False
        self.session_attached = False
        self.live = False
        self.closed = False

    async def send(self, message: dict) -> bool:
        return await self.send_bytes(_encode(message))

    async def send_bytes(self, raw: bytes) -> bool:
        async with self.send_lock:
            if self.closed:
                return False
            try:
                self.writer.write(raw + b"\n")
                await self.writer.drain()
                return True
            except (ConnectionError, OSError):
                self.close()
                return False

    async def deliver(self, message: dict) -> None:
        async with self.delivery_lock:
            if self.closed or not self.live:
                return
            await self.send(message)

    async def deliver_raw(self, raw: bytes) -> None:
        async with self.delivery_lock:
            if self.closed or not self.live:
                return
            await self.send_bytes(raw)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            self.writer.close()
        except (ConnectionError, OSError):
            pass


class Resident:
    def __init__(self, config: Config, paths: Paths):
        self.cfg = config
        self.paths = paths
        self.started_at = _now()
        self.state: Optional[str] = "starting"
        self.error: Optional[str] = None
        self.agent_pid: Optional[int] = None
        self.session_id: Optional[str] = None
        self.session_new_response: Optional[dict] = None
        self.initialize_response: Optional[dict] = None
        self.last_prompt: Optional[dict] = None
        self.status_data: Optional[dict] = None

        self.proc: Optional[asyncio.subprocess.Process] = None
        self.server: Optional[asyncio.AbstractServer] = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.ready: Optional[asyncio.Future] = None
        self.journal: Optional[Journal] = None
        self.clients: set = set()
        self.frontend: Optional[ClientConn] = None

        self.outbound: dict = {}
        self.prompts: dict = {}
        self.pending_client_requests: dict = {}
        self._next_child_id = 1
        self._next_gateway_id = 1_000_000
        self._child_stdin_lock = asyncio.Lock()

        self.shutdown_event = asyncio.Event()
        self.shutdown_reason: Optional[str] = None
        self.shutting_down = False
        self.stop_requested = False
        self.child_finalized = False
        self._cleaned = False
        self._bootstrap_task: Optional[asyncio.Task] = None
        self._child_reader_task: Optional[asyncio.Task] = None
        self._child_wait_task: Optional[asyncio.Task] = None

    # ---------------------------------------------------------------- startup

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.ready = self.loop.create_future()
        if socket_is_alive(self.paths.socket):
            raise ResidentAlreadyRunning(f"another resident already owns {self.paths.socket}")
        self.journal = Journal(self.paths.journal)
        try:
            os.unlink(self.paths.socket)
        except FileNotFoundError:
            pass
        self.server = await asyncio.start_unix_server(self._handle_client, path=self.paths.socket)
        try:
            os.chmod(self.paths.socket, 0o600)
        except OSError:
            pass
        self.write_status()
        self._bootstrap_task = self.loop.create_task(self._bootstrap())

    async def _bootstrap(self) -> None:
        try:
            await self._spawn_agent()
            self.write_status()
            initialize = await self._child_request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": {
                        "fs": {"readTextFile": False, "writeTextFile": False},
                        "terminal": False,
                    },
                    "clientInfo": {
                        "name": "tern-bot-worker",
                        "title": "tern-bot worker resident",
                        "version": WORKER_VERSION,
                    },
                },
                timeout=BOOTSTRAP_TIMEOUT,
            )
            if not isinstance(initialize, dict):
                raise ProtocolError("initialize response is not an object")
            self.initialize_response = initialize

            await self._child_request(
                "session/new",
                {"cwd": self.cfg.cwd, "mcpServers": []},
                timeout=BOOTSTRAP_TIMEOUT,
            )
            if not self.session_id:
                raise ProtocolError("session/new response carried no sessionId")
            self.state = None
            self.write_status()
            _log(f"bootstrap ready: session={self.session_id} agentPid={self.agent_pid}")
            if not self.ready.done():
                self.ready.set_result(None)

            if self.cfg.prompt:
                try:
                    await self.submit_prompt(self.cfg.prompt, origin="control")
                except Exception as exc:  # the session is alive; the prompt failure is recorded
                    _log(f"initial prompt could not be submitted: {exc}")
                    self.journal_event("initial_prompt_submit_failed", {"error": str(exc)})
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log(f"bootstrap failed: {exc}\n{traceback.format_exc()}")
            if self.state == "starting":
                self.state = "failed"
                self.error = f"bootstrap failed: {exc}"
                self.journal_event("bootstrap_failed", {"error": self.error})
                self.write_status()
            if self.ready is not None and not self.ready.done():
                self.ready.set_result(None)
            self.request_shutdown("bootstrap_failed")

    async def _spawn_agent(self) -> None:
        command = resolve_command(self.cfg.command, self.cfg.env)
        environment = dict(os.environ)
        environment.update(self.cfg.env)
        stderr = open(self.paths.agent_stderr, "ab", buffering=0)
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=self.cfg.cwd,
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=stderr,
                start_new_session=True,
            )
        finally:
            stderr.close()
        self.agent_pid = self.proc.pid
        _log(f"agent spawned: pid={self.agent_pid} command={command!r}")
        self._child_reader_task = self.loop.create_task(self._child_read_loop())
        self._child_wait_task = self.loop.create_task(self._child_wait_loop())

    # --------------------------------------------------------------- agent io

    async def _child_send(self, message: dict) -> None:
        async with self._child_stdin_lock:
            proc = self.proc
            if proc is None or proc.stdin is None or proc.returncode is not None:
                raise ProtocolError("agent process is not running")
            try:
                proc.stdin.write(_frame(message))
                await proc.stdin.drain()
            except (ConnectionError, BrokenPipeError, OSError) as exc:
                raise ProtocolError(f"agent stdin is closed: {exc}")

    def _alloc_child_id(self) -> int:
        value = self._next_child_id
        self._next_child_id += 1
        return value

    def _alloc_gateway_id(self) -> int:
        value = self._next_gateway_id
        self._next_gateway_id += 1
        return value

    async def _child_request(self, method: str, params: Any, timeout: Optional[float] = None) -> Any:
        if self.loop is None:
            raise ProtocolError("resident is not started")
        request_id = self._alloc_child_id()
        future: asyncio.Future = self.loop.create_future()
        self.outbound[request_id] = Outbound(method=method, future=future)
        frame = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        try:
            await self._child_send(frame)
        except Exception:
            self.outbound.pop(request_id, None)
            raise
        try:
            if timeout is None:
                return await future
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            self.outbound.pop(request_id, None)
            raise ProtocolError(f"agent did not answer {method} within {timeout:.0f}s")

    async def _child_read_loop(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        framer = LineFramer(self.proc.stdout)
        try:
            while True:
                raw = await framer.read_line()
                if raw is None:
                    break
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError as exc:
                    _log(f"agent wrote invalid JSON ({exc}): {raw[:200]!r}")
                    continue
                if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
                    _log(f"agent wrote a non JSON-RPC 2.0 frame: {raw[:200]!r}")
                    continue
                await self._on_agent_message(message, raw)
        except FrameTooLarge as exc:
            _log(f"agent frame rejected: {exc}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log(f"agent reader failed: {exc}\n{traceback.format_exc()}")
        finally:
            if not self.shutting_down:
                await self._finalize_agent(
                    "agent stdout closed (ACP protocol ended)", exit_note="stdout_eof"
                )

    async def _child_wait_loop(self) -> None:
        assert self.proc is not None
        returncode = await self.proc.wait()
        if self.shutting_down or self.stop_requested:
            return
        note = "exit"
        if returncode < 0:
            try:
                name = signal.Signals(-returncode).name
            except ValueError:
                name = f"signal {-returncode}"
            note = f"killed by {name}"
        await self._finalize_agent(
            f"agent process exited unexpectedly ({note}, code={returncode})",
            exit_note=note,
        )

    async def _finalize_agent(self, message: str, exit_note: str) -> None:
        if self.child_finalized:
            return
        self.child_finalized = True

        if self.stop_requested:
            self.request_shutdown("agent_exit")
            return

        reader = self._child_reader_task
        if reader is not None and reader is not asyncio.current_task() and not reader.done():
            try:
                await asyncio.wait_for(asyncio.shield(reader), 2.0)
            except Exception:
                pass

        for request_id, outbound in list(self.outbound.items()):
            if outbound.future is not None and not outbound.future.done():
                outbound.future.set_exception(ProtocolError(message))
        self.outbound.clear()
        self.prompts.clear()
        self.pending_client_requests.clear()

        self.state = "failed"
        self.error = message
        self.journal_event("agent_exit", {"reason": exit_note})
        self.write_status()
        _log(message)
        self.request_shutdown("agent_exit")

    async def _on_agent_message(self, message: dict, raw: bytes) -> None:
        if "method" in message:
            if "id" in message:
                await self._on_agent_request(message)
            else:
                await self._on_agent_notification(message, raw)
            return
        if "id" in message:
            await self._on_agent_response(message)
            return
        _log(f"agent wrote a message with neither method nor id: {raw[:200]!r}")

    async def _on_agent_response(self, message: dict) -> None:
        request_id = message.get("id")
        outbound = self.outbound.pop(request_id, None)
        if outbound is None:
            _log(f"agent answered unknown request id {request_id!r}; dropped")
            return

        if outbound.method == "session/new" and "result" in message and isinstance(message["result"], dict):
            self.session_new_response = message["result"]
            session_id = message["result"].get("sessionId")
            if isinstance(session_id, str) and session_id:
                self.session_id = session_id
        if outbound.method == "initialize" and "result" in message and isinstance(message["result"], dict):
            self.initialize_response = message["result"]

        if outbound.future is not None and not outbound.future.done():
            if "error" in message:
                error = message["error"] if isinstance(message["error"], dict) else {}
                outbound.future.set_exception(
                    JsonRpcError(
                        int(error.get("code", -32603)),
                        str(error.get("message", "agent request failed")),
                        error.get("data", _MISSING),
                    )
                )
            else:
                outbound.future.set_result(message.get("result"))

        if outbound.conn is not None:
            conn = outbound.conn
            if conn.outbound_ids.get(outbound.frontend_id) == request_id:
                conn.outbound_ids.pop(outbound.frontend_id, None)
            response = {"jsonrpc": "2.0", "id": outbound.frontend_id}
            if "error" in message:
                response["error"] = message["error"]
            else:
                response["result"] = message.get("result")
            if conn.closed:
                _log(f"frontend response for {outbound.method} dropped: frontend detached")
            else:
                await conn.send(response)

        if outbound.method == "session/prompt":
            self.prompts.pop(request_id, None)
            result = message.get("result") if isinstance(message.get("result"), dict) else {}
            error = message.get("error")
            self.last_prompt = {
                "origin": outbound.origin,
                "state": "error" if error is not None else "done",
                "stopReason": result.get("stopReason"),
                "error": error,
                "at": _now(),
            }
            self.journal_event(
                "prompt_result",
                {
                    "origin": outbound.origin,
                    "state": self.last_prompt["state"],
                    "stopReason": result.get("stopReason"),
                    "error": error,
                },
            )
            self.write_status()

    async def _on_agent_request(self, message: dict) -> None:
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params")
        if method == "session/request_permission":
            pending = PendingClientRequest(child_id=request_id, method=method, params=params)
            self.pending_client_requests[request_id] = pending
            _log(f"agent requests permission (id={request_id!r}); pending frontend answer")
            self.write_status()
            await self._offer_pending(pending)
            return
        _log(f"agent requested {method!r}, which this client capability set does not offer")
        try:
            await self._child_send(
                {"jsonrpc": "2.0", "id": request_id, "error": _method_not_found(str(method)).to_error()}
            )
        except ProtocolError:
            pass

    async def _on_agent_notification(self, message: dict, raw: bytes) -> None:
        method = message.get("method")
        params = message.get("params")
        if method == "session/update":
            if self.journal is None:
                return
            self.journal.append_raw(raw)
            session_id = params.get("sessionId") if isinstance(params, dict) else None
            if session_id != self.session_id:
                _log(f"session/update for foreign session {session_id!r}; journalled but not delivered")
                return
            conn = self.frontend
            if conn is not None:
                await conn.deliver_raw(raw)
            return

        if method == "$/cancel_request":
            request_id = params.get("requestId") if isinstance(params, dict) else None
            pending = self.pending_client_requests.pop(request_id, None)
            if pending is None:
                _log(f"agent cancelled unknown request {request_id!r}; ignored")
                return
            if pending.offered_to is not None and pending.gateway_id is not None:
                offered = pending.offered_to
                offered.pending_server_ids.pop(pending.gateway_id, None)
                await offered.send(
                    {"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": pending.gateway_id}}
                )
            self.journal_event("permission_cancelled", {"agentRequestId": request_id})
            self.write_status()
            return

        conn = self.frontend
        if conn is not None and conn.session_attached:
            await conn.deliver_raw(raw)
        else:
            _log(f"agent notification {method!r} dropped: no attached frontend")

    # ----------------------------------------------------------- client side

    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        conn = ClientConn(self, reader, writer)
        self.clients.add(conn)
        try:
            while True:
                raw = await conn.framer.read_line()
                if raw is None:
                    break
                await self._on_client_line(conn, raw)
        except FrameTooLarge as exc:
            _log(f"frontend frame rejected: {exc}")
            try:
                await conn.send(
                    {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error: frame too large"}}
                )
            except Exception:
                pass
        except asyncio.CancelledError:
            raise
        except (ConnectionError, OSError):
            pass
        except Exception as exc:
            _log(f"frontend connection failed: {exc}\n{traceback.format_exc()}")
        finally:
            was_frontend = self.frontend is conn
            conn.close()
            self.clients.discard(conn)
            if was_frontend:
                self.frontend = None
                for pending in conn.pending_server_ids.values():
                    pending.gateway_id = None
                    pending.offered_to = None
                conn.pending_server_ids.clear()
                conn.outbound_ids.clear()
                self.journal_event("frontend_detached", {})
                _log("frontend detached; resident and agent stay running")
                self.write_status()

    async def _on_client_line(self, conn: ClientConn, raw: bytes) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError as exc:
            _log(f"frontend wrote invalid JSON ({exc}): {raw[:200]!r}")
            await conn.send(
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
            )
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            _log(f"frontend wrote a non JSON-RPC 2.0 frame: {raw[:200]!r}")
            request_id = message.get("id") if isinstance(message, dict) else None
            await conn.send(
                {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32600, "message": "Invalid Request"}}
            )
            return

        method = message.get("method")
        if method is None:
            await self._on_frontend_response(conn, message)
            return

        if isinstance(method, str) and method.startswith("tern-bot/"):
            await self._on_control(conn, message)
            return

        if not conn.is_frontend:
            if method == "initialize":
                self._set_frontend(conn)
            else:
                if "id" in message:
                    await self._reply_error(
                        conn,
                        message.get("id"),
                        JsonRpcError(
                            -32000,
                            "frontend connection has not initialized",
                            {"method": method},
                        ),
                    )
                else:
                    _log(f"ignored frontend notification {method!r} from an uninitialized connection")
                return

        if "id" in message:
            await self._on_frontend_request(conn, message)
        else:
            await self._on_frontend_notification(conn, message)

    def _set_frontend(self, conn: ClientConn) -> None:
        conn.is_frontend = True
        previous = self.frontend
        if previous is conn:
            return
        self.frontend = conn
        self.journal_event("frontend_attached", {})
        _log("frontend attached and holds control")
        if previous is not None and not previous.closed:
            _log("previous frontend detached because a newer frontend attached")
            previous.close()
        self.write_status()

    async def _reply_result(self, conn: ClientConn, request_id: Any, result: Any) -> None:
        if request_id is None:
            return
        await conn.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    async def _reply_error(self, conn: ClientConn, request_id: Any, error: JsonRpcError) -> None:
        if request_id is None:
            return
        await conn.send({"jsonrpc": "2.0", "id": request_id, "error": error.to_error()})

    async def _on_frontend_response(self, conn: ClientConn, message: dict) -> None:
        request_id = message.get("id")
        pending = conn.pending_server_ids.pop(request_id, None)
        if pending is None:
            _log(f"frontend answered unknown gateway request {request_id!r}; dropped")
            return
        self.pending_client_requests.pop(pending.child_id, None)
        if "error" in message and isinstance(message.get("error"), dict):
            body = {"error": message["error"]}
        elif "result" in message:
            body = {"result": message.get("result")}
        else:
            body = {"error": {"code": -32600, "message": "Invalid response from frontend"}}
        try:
            await self._child_send({"jsonrpc": "2.0", "id": pending.child_id, **body})
        except ProtocolError as exc:
            _log(f"permission answer could not reach the agent: {exc}")
        self.write_status()

    # -------------------------------------------------------------- control

    async def _on_control(self, conn: ClientConn, message: dict) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        try:
            if method == "tern-bot/attach":
                self._set_frontend(conn)
                await self._reply_result(conn, request_id, {"attached": True})
            elif method == "tern-bot/status":
                await self._reply_result(conn, request_id, self.status())
            elif method == "tern-bot/prompt":
                await self._control_prompt(conn, request_id, params)
            elif method == "tern-bot/stop":
                _log("control stop requested")
                self.stop_requested = True
                await self._reply_result(conn, request_id, {"stopping": True})
                self.request_shutdown("control_stop")
            else:
                if request_id is None:
                    _log(f"unknown control notification {method!r} ignored")
                else:
                    await self._reply_error(conn, request_id, _method_not_found(str(method)))
        except JsonRpcError as exc:
            await self._reply_error(conn, request_id, exc)
        except Exception as exc:
            _log(f"control request {method!r} failed: {exc}\n{traceback.format_exc()}")
            await self._reply_error(conn, request_id, _internal_error(str(exc)))

    async def _control_prompt(self, conn: ClientConn, request_id: Any, params: Any) -> None:
        if not isinstance(params, dict):
            raise _invalid_params("tern-bot/prompt expects {\"text\": string}")
        text = params.get("text")
        if not isinstance(text, str) or not text.strip():
            raise _invalid_params("text must be a non-empty string")
        if not self.ready.done():
            raise JsonRpcError(-32003, "resident is still starting", {"phase": self._phase()})
        await self._await_ready()
        await self.submit_prompt(text, origin="control")
        await self._reply_result(
            conn,
            request_id,
            {"sessionId": self.session_id, "origin": "control", "submitted": True},
        )

    # ------------------------------------------------------------- requests

    async def _on_frontend_request(self, conn: ClientConn, message: dict) -> None:
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params")
        try:
            if self.frontend is not conn:
                raise JsonRpcError(-32000, "another frontend holds control", {"method": method})
            if method == "initialize":
                await self._frontend_initialize(conn, request_id, params)
            elif method in ("session/new", "session/load"):
                await self._frontend_attach(conn, request_id, str(method), params)
            elif method == "session/list":
                await self._frontend_list(conn, request_id)
            elif method == "session/prompt":
                self._require_resident_session(params)
                assert isinstance(params, dict)
                if not isinstance(params.get("prompt"), list):
                    raise _invalid_params("session/prompt requires a prompt array")
                forwarded = dict(params)
                forwarded["sessionId"] = self.session_id
                await self._forward(conn, request_id, "session/prompt", forwarded, origin="frontend")
            elif method == "session/close":
                raise JsonRpcError(
                    -32601,
                    "session/close is not supported: the resident owns the agent session; detach the frontend instead",
                    {"method": method},
                )
            elif method in ("session/resume", "session/fork"):
                raise _method_not_found(str(method))
            elif method == "session/set_mode":
                self._require_resident_session(params)
                assert isinstance(params, dict)
                forwarded = dict(params)
                forwarded["sessionId"] = self.session_id
                await self._forward(conn, request_id, "session/set_mode", forwarded)
            elif method == "session/set_config_option":
                self._require_resident_session(params)
                assert isinstance(params, dict)
                forwarded = dict(params)
                forwarded["sessionId"] = self.session_id
                await self._forward(conn, request_id, "session/set_config_option", forwarded)
            elif method == "authenticate":
                await self._forward(conn, request_id, "authenticate", params)
            else:
                await self._forward(conn, request_id, str(method), params)
        except JsonRpcError as exc:
            await self._reply_error(conn, request_id, exc)
        except Exception as exc:
            _log(f"frontend request {method!r} failed: {exc}\n{traceback.format_exc()}")
            await self._reply_error(conn, request_id, _internal_error(str(exc)))

    async def _frontend_initialize(self, conn: ClientConn, request_id: Any, params: Any) -> None:
        del params  # the agent is already initialized; the cached handshake is authoritative
        await self._await_ready()
        if not isinstance(self.initialize_response, dict):
            raise ProtocolError("resident has no cached initialize response")
        response = json.loads(json.dumps(self.initialize_response))
        capabilities = response.get("agentCapabilities")
        capabilities = dict(capabilities) if isinstance(capabilities, dict) else {}
        # The gateway attaches its live resident session even when the child does
        # not implement loadSession, and it does not accept new MCP servers.
        capabilities["loadSession"] = True
        capabilities.pop("mcpCapabilities", None)
        capabilities["sessionCapabilities"] = {"list": {}}
        response["agentCapabilities"] = capabilities
        auth_methods = response.get("authMethods")
        if isinstance(auth_methods, list):
            response["authMethods"] = [
                method
                for method in auth_methods
                if not (isinstance(method, dict) and method.get("type") == "terminal")
            ]
        meta = response.get("_meta")
        meta = dict(meta) if isinstance(meta, dict) else {}
        meta["ternBot"] = {
            "gateway": {"name": "tern-bot-worker", "version": WORKER_VERSION},
            "sessionId": self.session_id,
            "agentPid": self.agent_pid,
            "cwd": self.cfg.cwd,
            "history": "session/update history is replayed when a session is attached",
        }
        response["_meta"] = meta
        await self._reply_result(conn, request_id, response)

    async def _frontend_attach(self, conn: ClientConn, request_id: Any, method: str, params: Any) -> None:
        if not isinstance(params, dict):
            raise _invalid_params("session setup expects an object")
        await self._await_ready()
        if method == "session/load":
            requested = params.get("sessionId")
            if not isinstance(requested, str):
                raise _invalid_params("session/load requires a string sessionId")
            if requested != self.session_id:
                raise JsonRpcError(
                    -32602,
                    f"Unknown session: {requested}",
                    {"sessionId": requested, "residentSessionId": self.session_id},
                )

        source = self.session_new_response if isinstance(self.session_new_response, dict) else {}
        response: dict = {}
        if method == "session/new":
            response["sessionId"] = self.session_id
        for key in ("modes", "configOptions"):
            if key in source:
                response[key] = source[key]
        gateway_meta: dict = {
            "attached": "resident",
            "sessionId": self.session_id,
            "agentPid": self.agent_pid,
            "residentCwd": self.cfg.cwd,
        }
        requested_cwd = params.get("cwd")
        if isinstance(requested_cwd, str) and requested_cwd != self.cfg.cwd:
            gateway_meta["requestedCwd"] = requested_cwd
        ignored = []
        if params.get("mcpServers"):
            ignored.append("mcpServers")
        if params.get("additionalDirectories"):
            ignored.append("additionalDirectories")
        if ignored:
            gateway_meta["ignored"] = ignored
        response_meta = source.get("_meta")
        response_meta = dict(response_meta) if isinstance(response_meta, dict) else {}
        response_meta["ternBot"] = gateway_meta
        response["_meta"] = response_meta
        await self._reply_result(conn, request_id, response)

        if not conn.session_attached:
            await self._attach_replay(conn)

    async def _frontend_list(self, conn: ClientConn, request_id: Any) -> None:
        await self._await_ready()
        status = self.status()
        session = {
            "sessionId": self.session_id,
            "cwd": self.cfg.cwd,
            "title": None,
            "updatedAt": status.get("updatedAt"),
        }
        await self._reply_result(conn, request_id, {"sessions": [session]})

    async def _forward(
        self,
        conn: ClientConn,
        frontend_id: Any,
        method: str,
        params: Any,
        origin: Optional[str] = None,
    ) -> None:
        await self._await_ready()
        if self.frontend is not conn:
            raise JsonRpcError(-32000, "another frontend holds control", {"method": method})
        request_id = self._alloc_child_id()
        frame: dict = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        outbound = Outbound(method=method, conn=conn, frontend_id=frontend_id, origin=origin)
        self.outbound[request_id] = outbound
        conn.outbound_ids[frontend_id] = request_id
        if method == "session/prompt":
            self.prompts[request_id] = origin
            self.journal_event(
                "prompt_submitted",
                {"origin": origin, "requestId": request_id, "length": len(params.get("prompt") or [])},
            )
            self.write_status()
        try:
            await self._child_send(frame)
        except Exception as exc:
            self.outbound.pop(request_id, None)
            if conn.outbound_ids.get(frontend_id) == request_id:
                conn.outbound_ids.pop(frontend_id, None)
            if method == "session/prompt":
                self.prompts.pop(request_id, None)
                self.write_status()
            raise JsonRpcError(-32000, f"agent is not running: {exc}", {"method": method})

    async def _on_frontend_notification(self, conn: ClientConn, message: dict) -> None:
        method = message.get("method")
        params = message.get("params")
        if method == "session/cancel":
            session_id = params.get("sessionId") if isinstance(params, dict) else None
            if session_id != self.session_id:
                reason = f"unknown session {session_id!r}"
            elif self.frontend is not conn:
                reason = "sender is not the controlling frontend"
            elif self._active_prompt_origin() != "frontend":
                reason = f"active turn origin is {self._active_prompt_origin()!r}"
            else:
                reason = None
            if reason is not None:
                _log(f"session/cancel swallowed: {reason}")
                self.journal_event("cancel_swallowed", {"reason": reason})
                return
            try:
                await self._child_send(
                    {"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": self.session_id}}
                )
            except ProtocolError as exc:
                _log(f"session/cancel could not reach the agent: {exc}")
                return
            self.journal_event("cancel_forwarded", {"sessionId": self.session_id})
            return

        if method == "$/cancel_request":
            request_id = params.get("requestId") if isinstance(params, dict) else None
            child_id = conn.outbound_ids.get(request_id)
            if child_id is None:
                _log(f"$/cancel_request for unknown frontend request {request_id!r}; ignored")
                return
            try:
                await self._child_send(
                    {"jsonrpc": "2.0", "method": "$/cancel_request", "params": {"requestId": child_id}}
                )
            except ProtocolError as exc:
                _log(f"$/cancel_request could not reach the agent: {exc}")
            return

        _log(f"frontend notification {method!r} ignored")

    # -------------------------------------------------------------- replay

    async def _attach_replay(self, conn: ClientConn) -> None:
        conn.session_attached = True
        async with conn.delivery_lock:
            if conn.closed:
                return
            await self._replay_journal(conn)
            conn.live = True
        _log("frontend session attached; journalled history replayed")
        for pending in list(self.pending_client_requests.values()):
            await self._offer_pending(pending)

    async def _replay_journal(self, conn: ClientConn) -> None:
        journal = self.journal
        if journal is None:
            return
        end = journal.offset
        if end <= 0:
            return
        try:
            handle = open(self.paths.journal, "rb")
        except OSError as exc:
            _log(f"journal replay skipped: {exc}")
            return
        with handle:
            remaining = end
            buffer = b""
            while remaining > 0 and not conn.closed:
                chunk = handle.read(min(262144, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if not await self._replay_line(conn, line):
                        return
                await asyncio.sleep(0)
            if buffer.strip() and not conn.closed:
                await self._replay_line(conn, buffer)

    async def _replay_line(self, conn: ClientConn, line: bytes) -> bool:
        if not line.strip():
            return True
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return True
        if not isinstance(message, dict):
            return True
        if message.get("method") != "session/update":
            return True
        params = message.get("params")
        if not isinstance(params, dict) or params.get("sessionId") != self.session_id:
            return True
        return await conn.send_bytes(line.strip())

    async def _offer_pending(self, pending: PendingClientRequest) -> None:
        conn = self.frontend
        if conn is None or conn.closed or not conn.session_attached:
            return
        if pending.offered_to is conn and pending.gateway_id is not None:
            return
        if pending.offered_to is not None and pending.gateway_id is not None:
            pending.offered_to.pending_server_ids.pop(pending.gateway_id, None)
        gateway_id = self._alloc_gateway_id()
        pending.gateway_id = gateway_id
        pending.offered_to = conn
        conn.pending_server_ids[gateway_id] = pending
        delivered = await conn.send(
            {"jsonrpc": "2.0", "id": gateway_id, "method": pending.method, "params": pending.params}
        )
        if not delivered:
            conn.pending_server_ids.pop(gateway_id, None)
            pending.gateway_id = None
            pending.offered_to = None

    # --------------------------------------------------------------- status

    def _active_prompt_origin(self) -> Optional[str]:
        for origin in self.prompts.values():
            return origin
        return None

    def _phase(self) -> str:
        if self.state is not None:
            return self.state
        if self.pending_client_requests:
            return "waiting_input"
        if self.prompts:
            return "working"
        return "idle"

    def _build_status(self, at: str) -> dict:
        return {
            "pid": os.getpid(),
            "agentPid": self.agent_pid,
            "sessionId": self.session_id,
            "phase": self._phase(),
            "error": self.error,
            "pendingFrontendPermissionCount": len(self.pending_client_requests),
            "activePromptOrigin": self._active_prompt_origin(),
            "lastPrompt": self.last_prompt,
            "authMethods": self._auth_methods(),
            "cwd": self.cfg.cwd,
            "socket": self.paths.socket,
            "startedAt": self.started_at,
            "updatedAt": at,
        }

    def _auth_methods(self) -> list:
        response = self.initialize_response
        if not isinstance(response, dict):
            return []
        methods = response.get("authMethods")
        if not isinstance(methods, list):
            return []
        result = []
        for method in methods:
            if not isinstance(method, dict) or not isinstance(method.get("id"), str):
                continue
            entry = {"id": method["id"]}
            if isinstance(method.get("type"), str):
                entry["type"] = method["type"]
            if isinstance(method.get("name"), str):
                entry["name"] = method["name"]
            result.append(entry)
        return result

    def status(self) -> dict:
        if self.status_data is None:
            self.status_data = self._build_status(_now())
        return dict(self.status_data)

    def write_status(self) -> None:
        self.status_data = self._build_status(_now())
        temporary = self.paths.status + ".tmp"
        try:
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(self.status_data, handle, ensure_ascii=False, separators=(",", ":"))
                handle.write("\n")
            os.replace(temporary, self.paths.status)
        except OSError as exc:
            _log(f"status write failed: {exc}")

    def journal_event(self, event: str, payload: Optional[dict] = None) -> None:
        if self.journal is None:
            return
        params = {"event": event, "at": _now()}
        if payload:
            params.update(payload)
        try:
            self.journal.append_raw(_encode({"jsonrpc": "2.0", "method": "tern-bot/journal", "params": params}))
        except OSError as exc:
            _log(f"journal write failed: {exc}")

    # ------------------------------------------------------------- lifecycle

    async def _await_ready(self) -> None:
        if self.ready is None:
            raise _internal_error("resident is not started")
        if not self.ready.done():
            try:
                await asyncio.wait_for(asyncio.shield(self.ready), timeout=BOOTSTRAP_TIMEOUT + 5.0)
            except asyncio.TimeoutError:
                raise JsonRpcError(-32603, "resident is still starting", {"phase": self._phase()})
        if self.session_id is None:
            raise JsonRpcError(
                -32603,
                f"resident failed: {self.error or 'bootstrap did not complete'}",
                {"phase": self._phase(), "error": self.error},
            )
        if self.proc is None or self.proc.returncode is not None:
            raise JsonRpcError(
                -32603,
                f"agent is not running: {self.error or 'process exited'}",
                {"phase": self._phase(), "error": self.error},
            )

    def _require_resident_session(self, params: Any) -> None:
        if not isinstance(params, dict):
            raise _invalid_params("params must be an object")
        session_id = params.get("sessionId")
        if self.session_id is None or session_id != self.session_id:
            raise JsonRpcError(
                -32602,
                f"Unknown session: {session_id!r}",
                {"sessionId": session_id, "residentSessionId": self.session_id},
            )

    async def submit_prompt(self, text: str, origin: str) -> None:
        await self._await_ready()
        if not isinstance(text, str) or not text.strip():
            raise _invalid_params("text must be a non-empty string")
        request_id = self._alloc_child_id()
        outbound = Outbound(method="session/prompt", origin=origin, record=True)
        self.outbound[request_id] = outbound
        self.prompts[request_id] = origin
        self.journal_event(
            "prompt_submitted", {"origin": origin, "requestId": request_id, "length": len(text)}
        )
        self.write_status()
        try:
            await self._child_send(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "session/prompt",
                    "params": {
                        "sessionId": self.session_id,
                        "prompt": [{"type": "text", "text": text}],
                    },
                }
            )
        except Exception:
            self.outbound.pop(request_id, None)
            self.prompts.pop(request_id, None)
            self.write_status()
            raise

    def request_shutdown(self, reason: str) -> None:
        if self.shutdown_reason is None:
            self.shutdown_reason = reason
            _log(f"shutdown requested: {reason}")
        self.shutdown_event.set()

    def on_signal(self, signum: int) -> None:
        _log(f"received signal {signum}; terminating the agent")
        self.stop_requested = True
        self.request_shutdown(f"signal_{signum}")

    async def cleanup(self) -> None:
        if self._cleaned:
            return
        self._cleaned = True
        self.shutting_down = True
        self.journal_event("resident_stop", {"reason": self.shutdown_reason})
        if self.server is not None:
            self.server.close()
            try:
                await self.server.wait_closed()
            except Exception:
                pass
        await self._terminate_agent()
        tasks = [
            task
            for task in (self._child_reader_task, self._child_wait_task, self._bootstrap_task)
            if task is not None
        ]
        for task in tasks:
            if not task.done():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        for conn in list(self.clients):
            conn.close()
        if self.state not in ("failed", "exited"):
            self.state = "exited"
        self.write_status()
        if self.journal is not None:
            self.journal.close()
        try:
            os.unlink(self.paths.socket)
        except (FileNotFoundError, OSError):
            pass
        _log(f"resident stopped ({self.shutdown_reason or 'unknown reason'})")

    async def _terminate_agent(self) -> None:
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.stdin is not None and not proc.stdin.is_closing():
                proc.stdin.close()
        except (OSError, RuntimeError):
            pass
        if proc.returncode is not None:
            return
        _signal_process_group(proc.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), STOP_GRACE)
            return
        except asyncio.TimeoutError:
            pass
        _signal_process_group(proc.pid, signal.SIGKILL)
        try:
            await asyncio.wait_for(asyncio.shield(proc.wait()), STOP_GRACE)
        except asyncio.TimeoutError:
            _log("agent did not exit after SIGKILL")


def _signal_process_group(pid: int, signum: int) -> None:
    try:
        if os.getpgid(pid) == pid:
            os.killpg(pid, signum)
        else:
            os.kill(pid, signum)
    except (ProcessLookupError, PermissionError, OSError):
        pass


# ---------------------------------------------------------------- serve mode


async def run_serve(config_path: str) -> int:
    config = load_config(config_path)
    paths = paths_for(config.state_dir)
    try:
        ensure_state_dir(paths)
    except OSError as exc:
        _log(f"cannot prepare state directory {paths.state_dir}: {exc}")
        return 2
    if paths.state_dir == "/workspace" or paths.state_dir.startswith("/workspace/"):
        _log("warning: stateDir is inside /workspace and may be collected as a workspace artifact")
    resident = Resident(config, paths)
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, resident.on_signal, signum)
        except (NotImplementedError, RuntimeError):
            pass
    try:
        await resident.start()
    except (ResidentAlreadyRunning, ConfigError, OSError) as exc:
        _log(str(exc))
        return 2
    try:
        await resident.shutdown_event.wait()
    finally:
        await resident.cleanup()
    return 1 if resident.state == "failed" else 0


def cmd_serve(args: argparse.Namespace) -> int:
    try:
        return asyncio.run(run_serve(args.config))
    except KeyboardInterrupt:
        return 130


# --------------------------------------------------------------- launch mode


def cmd_launch(args: argparse.Namespace) -> int:
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 2
    paths = paths_for(config.state_dir)
    try:
        ensure_state_dir(paths)
    except OSError as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"cannot prepare state directory {paths.state_dir}: {exc}"},
                ensure_ascii=False,
            )
        )
        return 2

    if socket_is_alive(paths.socket):
        receipt = {
            "ok": False,
            "error": f"resident already running on {paths.socket}",
            "stateDir": paths.state_dir,
            "socket": paths.socket,
            "status": read_status(paths),
        }
        print(json.dumps(receipt, ensure_ascii=False))
        return 1

    script = os.path.abspath(__file__)
    try:
        log = open(paths.resident_log, "ab", buffering=0)
    except OSError as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"cannot open {paths.resident_log}: {exc}"},
                ensure_ascii=False,
            )
        )
        return 2
    try:
        process = subprocess.Popen(
            [sys.executable, script, "serve", "--config", os.path.abspath(args.config)],
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            cwd=paths.state_dir,
            start_new_session=True,
            close_fds=True,
        )
    except OSError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"cannot start resident: {exc}",
                    "stateDir": paths.state_dir,
                    "logTail": tail_text(paths.resident_log),
                },
                ensure_ascii=False,
            )
        )
        return 1
    finally:
        log.close()

    deadline = time.monotonic() + LAUNCH_READY_TIMEOUT
    while time.monotonic() < deadline:
        status = read_status(paths)
        if status is not None and status.get("pid") == process.pid:
            phase = status.get("phase")
            if phase in ("idle", "working", "waiting_input"):
                receipt = {
                    "ok": True,
                    "stateDir": paths.state_dir,
                    "socket": paths.socket,
                    "pid": status.get("pid"),
                    "agentPid": status.get("agentPid"),
                    "sessionId": status.get("sessionId"),
                    "phase": phase,
                    "authMethods": status.get("authMethods") or [],
                    "statusFile": paths.status,
                    "journalFile": paths.journal,
                    "logFile": paths.resident_log,
                    "agentStderrFile": paths.agent_stderr,
                    "configFile": os.path.abspath(args.config),
                    "cwd": config.cwd,
                    "command": config.command,
                }
                print(json.dumps(receipt, ensure_ascii=False))
                return 0
            if phase in ("failed", "exited"):
                receipt = {
                    "ok": False,
                    "error": status.get("error") or "resident bootstrap failed",
                    "stateDir": paths.state_dir,
                    "socket": paths.socket,
                    "pid": status.get("pid"),
                    "phase": phase,
                    "status": status,
                    "logTail": tail_text(paths.resident_log),
                    "agentStderrTail": tail_text(paths.agent_stderr),
                }
                print(json.dumps(receipt, ensure_ascii=False))
                return 1
        if process.poll() is not None:
            receipt = {
                "ok": False,
                "error": f"resident exited during bootstrap (code={process.returncode})",
                "stateDir": paths.state_dir,
                "socket": paths.socket,
                "pid": process.pid,
                "status": read_status(paths),
                "logTail": tail_text(paths.resident_log),
                "agentStderrTail": tail_text(paths.agent_stderr),
            }
            print(json.dumps(receipt, ensure_ascii=False))
            return 1
        time.sleep(0.1)

    receipt = {
        "ok": False,
        "error": f"resident did not become ready within {LAUNCH_READY_TIMEOUT:.0f}s",
        "stateDir": paths.state_dir,
        "socket": paths.socket,
        "pid": process.pid,
        "status": read_status(paths),
        "logTail": tail_text(paths.resident_log),
        "agentStderrTail": tail_text(paths.agent_stderr),
    }
    print(json.dumps(receipt, ensure_ascii=False))
    return 1


# -------------------------------------------------------------- connect mode


async def run_connect(state_dir: str) -> int:
    paths = paths_for(state_dir)
    try:
        reader, writer = await asyncio.open_unix_connection(paths.socket)
    except OSError as exc:
        _log(f"cannot connect to resident at {paths.socket}: {exc}")
        return 1

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def feed_stdin() -> None:
        try:
            descriptor = sys.stdin.fileno()
        except (AttributeError, OSError):
            loop.call_soon_threadsafe(queue.put_nowait, None)
            return
        while True:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return
            loop.call_soon_threadsafe(queue.put_nowait, chunk)

    threading.Thread(target=feed_stdin, name="tern-bot-stdin", daemon=True).start()

    writer.write(_frame({"jsonrpc": "2.0", "method": "tern-bot/attach", "params": {"client": "connect"}}))
    try:
        await writer.drain()
    except (ConnectionError, OSError):
        writer.close()
        return 1

    async def stdin_to_socket() -> None:
        while True:
            chunk = await queue.get()
            if chunk is None:
                return
            writer.write(chunk)
            await writer.drain()

    async def socket_to_stdout() -> None:
        output = sys.stdout.buffer
        while True:
            data = await reader.read(65536)
            if not data:
                return
            output.write(data)
            output.flush()

    stdin_task = asyncio.ensure_future(stdin_to_socket())
    socket_task = asyncio.ensure_future(socket_to_stdout())
    try:
        done, _ = await asyncio.wait({stdin_task, socket_task}, return_when=asyncio.FIRST_COMPLETED)
        if stdin_task in done:
            # Stdin ended: detach by half-closing, then forward whatever the
            # resident still sends until it closes its side.
            try:
                stdin_task.result()
            except (ConnectionError, OSError):
                pass
            if writer.can_write_eof():
                try:
                    writer.write_eof()
                except OSError:
                    pass
            try:
                await asyncio.wait_for(asyncio.shield(socket_task), 3.0)
            except (asyncio.TimeoutError, ConnectionError, OSError):
                pass
        else:
            try:
                socket_task.result()
            except (ConnectionError, OSError):
                pass
    finally:
        for task in (stdin_task, socket_task):
            if not task.done():
                task.cancel()
        await asyncio.gather(stdin_task, socket_task, return_exceptions=True)
        try:
            writer.close()
            await writer.wait_closed()
        except (ConnectionError, OSError):
            pass
    return 0


def cmd_connect(args: argparse.Namespace) -> int:
    try:
        return asyncio.run(run_connect(args.state_dir))
    except KeyboardInterrupt:
        return 130


# -------------------------------------------------------------- request mode


async def run_request(state_dir: str, method: str, params: Any, timeout: Optional[float]) -> int:
    paths = paths_for(state_dir)
    try:
        reader, writer = await asyncio.open_unix_connection(paths.socket)
    except OSError as exc:
        _log(f"cannot connect to resident at {paths.socket}: {exc}")
        return 1
    message: dict = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        message["params"] = params
    writer.write(_frame(message))
    try:
        await writer.drain()
    except (ConnectionError, OSError) as exc:
        _log(f"resident connection failed: {exc}")
        return 1
    framer = LineFramer(reader)
    try:
        raw = await (asyncio.wait_for(framer.read_line(), timeout) if timeout else framer.read_line())
    except asyncio.TimeoutError:
        _log(f"resident did not answer {method} within {timeout:.0f}s")
        writer.close()
        return 1
    finally:
        writer.close()
    if raw is None:
        _log("resident closed the connection without answering")
        return 1
    try:
        response = json.loads(raw)
    except json.JSONDecodeError as exc:
        _log(f"resident answered with invalid JSON: {exc}: {raw[:200]!r}")
        return 1
    if not isinstance(response, dict):
        _log("resident answered with a non-object frame")
        return 1
    if "error" in response:
        print(json.dumps({"error": response["error"]}, ensure_ascii=False))
        return 1
    print(json.dumps(response.get("result"), ensure_ascii=False))
    return 0


def cmd_request(args: argparse.Namespace) -> int:
    params = None
    if args.params is not None:
        try:
            params = json.loads(args.params)
        except json.JSONDecodeError as exc:
            _log(f"--params is not valid JSON: {exc}")
            return 2
    timeout = args.timeout if args.timeout and args.timeout > 0 else None
    try:
        return asyncio.run(run_request(args.state_dir, args.method, params, timeout))
    except KeyboardInterrupt:
        return 130


# -------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="worker.py",
        description="tern-bot worker resident: a detachable ACP gateway in front of one agent CLI process.",
    )
    subparsers = parser.add_subparsers(dest="mode", required=True)

    launch = subparsers.add_parser("launch", help="start a detached resident and print a readiness receipt")
    launch.add_argument("--config", required=True, help="path to the JSON bootstrap config")
    launch.set_defaults(handler=cmd_launch)

    serve = subparsers.add_parser("serve", help="run the resident (daemon)")
    serve.add_argument("--config", required=True, help="path to the JSON bootstrap config")
    serve.set_defaults(handler=cmd_serve)

    connect = subparsers.add_parser("connect", help="relay stdin/stdout to the resident socket")
    connect.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help=f"resident state directory (default {DEFAULT_STATE_DIR})")
    connect.set_defaults(handler=cmd_connect)

    request = subparsers.add_parser("request", help="send one control request")
    request.add_argument("--state-dir", default=DEFAULT_STATE_DIR, help=f"resident state directory (default {DEFAULT_STATE_DIR})")
    request.add_argument("--method", required=True, help="control method, e.g. tern-bot/status")
    request.add_argument("--params", default=None, help="JSON params for the control method")
    request.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for the answer (0 = wait forever)")
    request.set_defaults(handler=cmd_request)
    return parser


def main(argv: Optional[list] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
