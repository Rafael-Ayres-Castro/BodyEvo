"""Acesso ao Supabase pela API REST (PostgREST), com a chave service-role.

A service-role ignora a RLS: ela só existe nas variáveis de ambiente da api/,
nunca no app nem no git.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

_cliente: httpx.AsyncClient | None = None


def cliente() -> httpx.AsyncClient:
    global _cliente
    if _cliente is None:
        _cliente = httpx.AsyncClient(
            base_url=f"{SUPABASE_URL}/rest/v1",
            headers={
                "apikey": SERVICE_KEY,
                "Authorization": f"Bearer {SERVICE_KEY}",
                "Content-Type": "application/json",
            },
            timeout=20,
        )
    return _cliente


async def selecionar(tabela: str, params: dict[str, str]) -> list[dict[str, Any]]:
    r = await cliente().get(f"/{tabela}", params=params)
    r.raise_for_status()
    return r.json()


async def inserir(tabela: str, linha: dict[str, Any], *, ignorar_duplicado: bool = False,
                  conflito: str | None = None) -> list[dict[str, Any]]:
    """Insere e devolve as linhas inseridas. Com ignorar_duplicado, uma linha que já existe
    não é alterada e a lista volta vazia (é assim que as rotas ficam idempotentes)."""
    prefer = ["return=representation"]
    if ignorar_duplicado:
        prefer.append("resolution=ignore-duplicates")
    params = {"on_conflict": conflito} if conflito else None
    r = await cliente().post(f"/{tabela}", json=linha, params=params, headers={"Prefer": ",".join(prefer)})
    r.raise_for_status()
    return r.json()


async def atualizar(tabela: str, filtros: dict[str, str], campos: dict[str, Any]) -> None:
    r = await cliente().patch(f"/{tabela}", params=filtros, json=campos)
    r.raise_for_status()


async def apagar(tabela: str, filtros: dict[str, str]) -> None:
    r = await cliente().delete(f"/{tabela}", params=filtros)
    r.raise_for_status()


async def usuario_do_token(token: str) -> dict[str, Any] | None:
    """Valida o JWT da sessão do app no Supabase Auth e devolve o usuário (ou None)."""
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{SUPABASE_URL}/auth/v1/user",
                        headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {token}"})
    if r.status_code != 200:
        return None
    return r.json()


# ---------- Estado da api/ (token do Garmin) em public.api_state ----------

async def ler_estado(chave: str) -> Any:
    linhas = await selecionar("api_state", {"key": f"eq.{chave}", "select": "value"})
    return linhas[0]["value"] if linhas else None


async def gravar_estado(chave: str, valor: Any) -> None:
    r = await cliente().post(
        "/api_state", json={"key": chave, "value": valor},
        headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    r.raise_for_status()
