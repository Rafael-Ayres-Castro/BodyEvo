"""Gera dados/taco.json a partir da TACO (4ª edição, NEPA/UNICAMP).

Fonte: os CSVs de references/csv do projeto github.com/raulfdm/taco-api (MIT), que converteu a planilha
oficial do NEPA. "Tr" (traços) já vem como 0; "NA" e "*" (não aplicável / em reanálise) vêm vazios e
ficam como null. Alimentos sem calorias na tabela (ex.: sal) ficam de fora.

Uso (na raiz do projeto):  python3 -I ferramentas/gerar_taco.py
"""
import csv
import io
import json
import os
import urllib.request

COMMIT = "06e466ad2f3d76064b587808b1804564b2c40f67"
BASE = f"https://raw.githubusercontent.com/raulfdm/taco-api/{COMMIT}/references/csv/"
SAIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dados", "taco.json")


def baixar(nome):
    with urllib.request.urlopen(BASE + nome, timeout=30) as r:
        return list(csv.DictReader(io.StringIO(r.read().decode("utf-8"))))


def numero(texto, casas):
    texto = (texto or "").strip()
    if not texto:
        return None
    v = round(float(texto), casas)
    return int(v) if casas == 0 else v


def main():
    nomes = {r["id"]: r["name"].strip() for r in baixar("food.csv")}
    itens = []
    for n in baixar("nutrients.csv"):
        kcal = numero(n["kcal"], 0)
        if not kcal:
            continue
        itens.append([nomes[n["foodId"]], kcal, numero(n["protein"], 1),
                      numero(n["carbohydrates"], 1), numero(n["lipids"], 1)])
    itens.sort(key=lambda i: i[0])
    dados = {
        "fonte": "TACO 4ª edição (NEPA/UNICAMP), via github.com/raulfdm/taco-api@" + COMMIT[:7],
        "campos": ["nome", "kcal", "proteina", "carboidrato", "gordura"],
        "por": "100 g",
        "itens": itens,
    }
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, "w", encoding="utf-8") as f:
        json.dump(dados, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(itens)} alimentos → {os.path.normpath(SAIDA)} ({os.path.getsize(SAIDA) // 1024} KB)")


if __name__ == "__main__":
    main()
