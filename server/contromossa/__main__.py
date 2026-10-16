"""Command line: python -m quizzone run | validate | ports"""
from __future__ import annotations

import argparse
import os
import sys

from .content import ContentError, load_quiz
from .engine import Config, Engine
from .links import SerialTransport, TcpTransport, find_serial_ports
from .server import App
from .store import Store

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

def _content(a):
    return a.content or os.path.join(ROOT, "content")


def cmd_validate(a) -> int:
    try:
        quiz = load_quiz(_content(a))
    except ContentError as e:
        print("CONTENUTO NON VALIDO / INVALID CONTENT:")
        for p in e.problems:
            print("  -", p)
        return 1
    print(f"OK: {len(quiz.questions)} domande, lingue: {', '.join(quiz.languages)}")
    return 0


def cmd_ports(a) -> int:
    ports = find_serial_ports()
    if ports is None:
        print("pyserial non installato / not installed:  pip install pyserial")
        return 1
    if not ports:
        print("Nessuna porta seriale trovata / no serial ports found")
    for dev, desc, mb in ports:
        print(f"{dev:20s} {'[micro:bit] ' if mb else '            '}{desc}")
    return 0


def cmd_run(a) -> int:
    try:
        quiz = load_quiz(_content(a))
    except ContentError as e:
        print("CONTENUTO NON VALIDO / INVALID CONTENT:")
        for p in e.problems:
            print("  -", p)
        return 1
    if a.sim:
        from .sim import SimTransport
        transport = SimTransport(teams=a.sim)
    elif a.tcp:
        host, _, port = a.tcp.rpartition(":")
        transport = TcpTransport(host or "127.0.0.1", int(port))
    else:
        transport = SerialTransport(a.serial)
    data = os.path.abspath(a.data or os.path.join(ROOT, "data", "state.json"))
    cfg = Config()
    if a.teams:
        cfg.teams = a.teams
    engine = Engine(quiz, Store(data), config=cfg)
    app = App(engine, transport, token=a.token)
    httpd = app.serve(a.host, a.port)
    app.start_background()
    shown = "localhost" if a.host in ("127.0.0.1", "0.0.0.0") else a.host
    print(f"Schermo:   http://{shown}:{a.port}/")
    print(f"Controllo: http://{shown}:{a.port}/control" + (f"?token={a.token}" if a.token else ""))
    print(f"Stato salvato in: {data}")
    if a.host not in ("127.0.0.1", "localhost") and not a.token:
        print("ATTENZIONE: server raggiungibile in rete senza --token: chiunque puo' comandare il quiz.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nArresto...")
    finally:
        app.shutdown()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="quizzone")
    ap.add_argument("--content", help="cartella con quiz.json e texts/")
    sub = ap.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="avvia il server")
    r.add_argument("--port", type=int, default=8080)
    r.add_argument("--host", default="127.0.0.1")
    r.add_argument("--token")
    r.add_argument("--serial", help="porta seriale (default: autorilevamento micro:bit)")
    r.add_argument("--sim", type=int, metavar="N", help="demo senza hardware con N squadre virtuali")
    r.add_argument("--tcp", metavar="HOST:PORT", help="simulatore radio Node")
    r.add_argument("--teams", type=int)
    r.add_argument("--data", help="file di stato")
    sub.add_parser("validate", help="controlla quiz.json e i testi")
    sub.add_parser("ports", help="elenca le porte seriali")
    a = ap.parse_args(argv)
    return {"run": cmd_run, "validate": cmd_validate, "ports": cmd_ports}.get(a.cmd, lambda a: ap.print_help() or 1)(a)


if __name__ == "__main__":
    sys.exit(main())
