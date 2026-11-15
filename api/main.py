"""Rumo — api/ mínima: só o que exige segredo ou horário agendado.

  POST /garmin/sync              botão "Atualizar" do app (JWT do Supabase)
  POST /internal/garmin/sync     agendador (token interno)
  POST /internal/push/{tipo}     agendador (token interno): pesagem | checkin | resumo | pendentes
  GET  /health

O app nunca depende desta API: ela grava direto nas tabelas e o app lê pelo fluxo normal
de sincronização. Rodar localmente:  cd api && uvicorn main:app --reload
"""

from __future__ import annotations

import os
import secrets
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import Body, Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import garmin
import push
import supa

FUSO = ZoneInfo("America/Sao_Paulo")
USER_ID = os.environ.get("RUMO_USER_ID", "")            # o único usuário (a chave do Garmin é pessoal)
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "")
ORIGENS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "https://rafael-ayres-castro.github.io").split(",") if o.strip()]

app = FastAPI(title="Rumo API", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGENS,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Sem token.")
    return authorization.split(" ", 1)[1].strip()


async def usuario_do_app(authorization: str | None = Header(default=None)) -> str:
    """Valida o JWT da sessão do app no Supabase Auth."""
    user = await supa.usuario_do_token(_bearer(authorization))
    if not user:
        raise HTTPException(401, "Sessão inválida.")
    if USER_ID and user["id"] != USER_ID:
        raise HTTPException(403, "Usuário não autorizado.")
    return user["id"]


def agendador(authorization: str | None = Header(default=None)) -> None:
    if not INTERNAL_TOKEN or not secrets.compare_digest(_bearer(authorization), INTERNAL_TOKEN):
        raise HTTPException(401, "Token interno inválido.")


def _dias_para_sincronizar(dia: date | None) -> list[date]:
    """O dia pedido (ou hoje) e o anterior: o total de ontem só fecha depois da meia-noite."""
    alvo = dia or datetime.now(FUSO).date()
    return [alvo, alvo - timedelta(days=1)]


async def _sincronizar(user_id: str, dia: date | None) -> dict:
    try:
        feitos = [r for d in _dias_para_sincronizar(dia) if (r := await garmin.sincronizar_dia(user_id, d))]
    except garmin.GarminErro as e:
        raise HTTPException(502, str(e)) from e
    return {"sincronizados": feitos}


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/garmin/sync")
async def garmin_sync(corpo: dict = Body(default={}), user_id: str = Depends(usuario_do_app)) -> dict:
    dia = date.fromisoformat(corpo["date"]) if corpo.get("date") else None
    return await _sincronizar(user_id, dia)


@app.post("/internal/garmin/sync", dependencies=[Depends(agendador)])
async def garmin_sync_agendado() -> dict:
    if not USER_ID:
        raise HTTPException(500, "RUMO_USER_ID não configurado.")
    agora = datetime.now(FUSO)
    if not (6 <= agora.hour <= 23):   # 06:00 às 23:59 em São Paulo
        return {"ignorado": "fora do horário"}
    return await _sincronizar(USER_ID, None)


@app.post("/internal/push/{tipo}", dependencies=[Depends(agendador)])
async def push_agendado(tipo: str, forcar: bool = False) -> dict:
    if tipo not in ("pesagem", "checkin", "resumo", "pendentes"):
        raise HTTPException(404, "Tipo desconhecido.")
    if not USER_ID:
        raise HTTPException(500, "RUMO_USER_ID não configurado.")
    return {"enviados": await push.enviar(USER_ID, tipo, forcar=forcar)}
