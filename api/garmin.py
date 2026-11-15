"""Garmin Connect — API pessoal (Connect Developer Program, chave pessoal).

Fontes (conferidas em 05/11/2026):
  - https://developer.garmin.com/gc-developer-program/personal/personal-api
  - Swagger da API pessoal (developer.garmin.com/gc-developer-program/personal/swagger-docs/)
  - Cliente oficial: https://github.com/garmin/connect-personal-api-python

  Token:  POST {base}/personalapitoken-service/personal-api/personal-api-key/token
          header "Authorization: ApiKey <chave>". A resposta é o JWT em texto puro;
          vale 24 h (claim "exp"). Não há refresh token: pede-se outro.
  Resumo: GET {base}/usersummary-service/usersummary/daily?calendarDate=AAAA-MM-DD
          header "Authorization: Bearer <token>" → UserDailySummaryDto, com
          totalKilocalories, activeKilocalories, bmrKilocalories e lastSyncTimestampGMT.
"""

from __future__ import annotations

import base64
import json
import os
import time
from datetime import date, datetime, timezone
from typing import Any

import httpx

import supa

BASE_URL = os.environ.get("GARMIN_BASE_URL", "https://personal.connectapi.garmin.com").rstrip("/")
API_KEY = os.environ.get("GARMIN_API_KEY", "")
TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token"
RESUMO_PATH = "/usersummary-service/usersummary/daily"
JANELA_RENOVACAO = 60 * 60   # renova o token quando falta menos de 1 h (como o cliente oficial)


class GarminErro(Exception):
    pass


def _exp_do_jwt(token: str) -> float:
    try:
        carga = token.split(".")[1]
        dados = json.loads(base64.urlsafe_b64decode(carga + "=" * (-len(carga) % 4)))
        return float(dados["exp"])
    except (IndexError, KeyError, ValueError) as e:
        raise GarminErro("O endpoint de token não devolveu um JWT com exp.") from e


async def obter_token(forcar: bool = False) -> str:
    """Token guardado em public.api_state (a hospedagem gratuita reinicia a api/ com frequência)."""
    if not API_KEY:
        raise GarminErro("GARMIN_API_KEY não configurada.")
    if not forcar:
        salvo = await supa.ler_estado("garmin_token")
        if salvo and salvo.get("expires_at", 0) - time.time() > JANELA_RENOVACAO:
            return salvo["access_token"]
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(BASE_URL + TOKEN_PATH, headers={"Accept": "*/*", "Authorization": f"ApiKey {API_KEY}"})
    if r.status_code != 200:
        raise GarminErro(f"Token recusado pelo Garmin (HTTP {r.status_code}).")
    token = r.text.strip()
    await supa.gravar_estado("garmin_token", {"access_token": token, "expires_at": _exp_do_jwt(token)})
    return token


async def resumo_do_dia(dia: date) -> dict[str, Any] | None:
    token = await obter_token()
    for tentativa in range(2):
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.get(BASE_URL + RESUMO_PATH, params={"calendarDate": dia.isoformat()},
                            headers={"Accept": "application/json", "Authorization": f"Bearer {token}"})
        if r.status_code == 401 and tentativa == 0:
            token = await obter_token(forcar=True)
            continue
        if r.status_code == 204 or not r.content:
            return None
        if r.status_code != 200:
            raise GarminErro(f"Resumo diário recusado (HTTP {r.status_code}).")
        return r.json()
    return None


def _quando(texto: str | None) -> str:
    """lastSyncTimestampGMT vem sem fuso; é GMT. Sem o campo, usa agora."""
    if texto:
        try:
            t = datetime.fromisoformat(texto.replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=timezone.utc)
            return t.isoformat()
        except ValueError:
            pass
    return datetime.now(timezone.utc).isoformat()


def _int(x: Any) -> int | None:
    return None if x is None else int(round(float(x)))


async def sincronizar_dia(user_id: str, dia: date) -> dict[str, Any] | None:
    """Grava o gasto do Garmin em daily_logs. Nunca sobrescreve um gasto manual."""
    dto = await resumo_do_dia(dia)
    if not dto:
        return None
    ativas = _int(dto.get("activeKilocalories"))
    repouso = _int(dto.get("bmrKilocalories"))
    total = _int(dto.get("totalKilocalories"))
    if total is None and (ativas is not None or repouso is not None):
        total = (ativas or 0) + (repouso or 0)
    if total is None:
        return None
    garmin = {
        "garmin_active_kcal": ativas,
        "garmin_bmr_kcal": repouso,
        "garmin_synced_at": _quando(dto.get("lastSyncTimestampGMT")),
    }
    filtro = {"user_id": f"eq.{user_id}", "date": f"eq.{dia.isoformat()}"}
    existentes = await supa.selecionar("daily_logs", {**filtro, "select": "id,burned_source"})
    if not existentes:
        novo = await supa.inserir("daily_logs", {
            "user_id": user_id, "date": dia.isoformat(), **garmin,
            "kcal_burned": total, "burned_source": "garmin",
        }, ignorar_duplicado=True, conflito="user_id,date")
        if novo:
            return {"data": dia.isoformat(), "total": total}
        existentes = await supa.selecionar("daily_logs", {**filtro, "select": "id,burned_source"})
    campos = dict(garmin)
    if not existentes or existentes[0].get("burned_source") != "manual":
        campos.update({"kcal_burned": total, "burned_source": "garmin"})
    await supa.atualizar("daily_logs", filtro, campos)
    return {"data": dia.isoformat(), "total": total}
