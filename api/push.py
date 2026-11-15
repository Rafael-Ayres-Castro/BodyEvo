"""Notificações Web Push (pesagem, check-in e resumo do dia).

Idempotente: antes de enviar, grava (user_id, tipo, data) em notifications_sent.
Se a linha já existia, nada é enviado de novo, mesmo que o agendador rode duas vezes.
"""

from __future__ import annotations

import json
import os
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from pywebpush import WebPushException, webpush

import supa

FUSO = ZoneInfo("America/Sao_Paulo")
VAPID_PRIVADA = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:rumo@example.com")
JANELA_HORAS = 3   # o cron do GitHub Actions pode atrasar; depois disso o lembrete perde o sentido


def _hora(texto: str) -> time:
    h, m = texto.split(":")[:2]
    return time(int(h), int(m))


def _fmt_int(n: float) -> str:
    return f"{round(n):,}".replace(",", ".")


async def _dados(user_id: str) -> dict[str, Any]:
    s = (await supa.selecionar("settings", {"user_id": f"eq.{user_id}", "select": "*"}) or [None])[0]
    if not s:
        raise RuntimeError("Usuário sem settings no Supabase.")
    return s


async def _ingeridas(user_id: str, dia: date) -> float:
    itens = await supa.selecionar("meal_entries", {
        "user_id": f"eq.{user_id}", "date": f"eq.{dia.isoformat()}", "select": "grams,kcal_100g",
    })
    return sum((float(i["grams"] or 0) / 100) * float(i["kcal_100g"] or 0) for i in itens)


async def _meta(user_id: str, dia: date) -> int | None:
    m = await supa.selecionar("kcal_targets", {
        "user_id": f"eq.{user_id}", "effective_from": f"lte.{dia.isoformat()}",
        "select": "kcal", "order": "effective_from.desc", "limit": "1",
    })
    return m[0]["kcal"] if m else None


async def _enviar(user_id: str, tipo: str, dia: date, mensagem: dict[str, Any]) -> int:
    marcado = await supa.inserir("notifications_sent", {"user_id": user_id, "kind": tipo, "date": dia.isoformat()},
                                 ignorar_duplicado=True, conflito="user_id,kind,date")
    if not marcado:
        return 0   # já enviada hoje
    inscricoes = await supa.selecionar("push_subscriptions", {"user_id": f"eq.{user_id}", "select": "*"})
    enviados = 0
    for sub in inscricoes:
        try:
            webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=json.dumps(mensagem),
                vapid_private_key=VAPID_PRIVADA,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=3 * 3600,
            )
            enviados += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):   # inscrição vencida: some da tabela
                await supa.apagar("push_subscriptions", {"endpoint": f"eq.{sub['endpoint']}"})
    return enviados


async def enviar(user_id: str, tipo: str, forcar: bool = False) -> dict[str, Any]:
    """tipo: pesagem | checkin | resumo | pendentes (confere os horários de todos)."""
    s = await _dados(user_id)
    agora = datetime.now(FUSO)
    hoje = agora.date()
    inicio = date.fromisoformat(s["start_date"])
    dia_checkin = (hoje - inicio).days >= 0 and (hoje - inicio).days % 7 == 0
    resultado: dict[str, Any] = {}

    def na_janela(hora: str) -> bool:
        alvo = datetime.combine(hoje, _hora(hora), FUSO)
        return alvo <= agora < alvo + timedelta(hours=JANELA_HORAS)

    # Pesagem (e check-in, no 1º dia da semana do bulking)
    quer_pesagem = tipo in ("pesagem", "checkin") or (tipo == "pendentes" and na_janela(s["weigh_reminder_time"]))
    if quer_pesagem and (forcar or s["remind_weigh"] or (dia_checkin and s["remind_checkin"])):
        if dia_checkin and s["remind_checkin"]:
            msg = {"title": "Pesagem e check-in", "tag": "pesagem",
                   "body": "Hoje é dia de check-in: peso em jejum, as 7 medidas com fita e a dobra abdominal.",
                   "url": "./#hoje"}
        else:
            msg = {"title": "Hora de pesar", "tag": "pesagem", "body": "Em jejum, depois do banheiro.", "url": "./#hoje"}
        resultado["pesagem"] = await _enviar(user_id, "pesagem", hoje, msg)

    # Resumo do dia
    quer_resumo = tipo == "resumo" or (tipo == "pendentes" and na_janela(s["summary_time"]))
    if quer_resumo and (forcar or s["remind_summary"]):
        log = await supa.selecionar("daily_logs", {"user_id": f"eq.{user_id}", "date": f"eq.{hoje.isoformat()}", "select": "closed_at"})
        if not (log and log[0].get("closed_at")):
            kcal = await _ingeridas(user_id, hoje)
            meta = await _meta(user_id, hoje)
            corpo = f"{_fmt_int(kcal)} de {_fmt_int(meta)} kcal · toque para ver o resumo" if meta else "Toque para ver o resumo"
            resultado["resumo"] = await _enviar(user_id, "resumo", hoje, {
                "title": "Seu dia está pronto", "body": corpo, "tag": "resumo",
                "url": "./?abrir=resumo#hoje", "abrir": "resumo",
            })
    return resultado
