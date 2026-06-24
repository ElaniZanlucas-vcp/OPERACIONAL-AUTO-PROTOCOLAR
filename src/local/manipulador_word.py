import json
import sys
from pathlib import Path

RESULTS_FILE = Path(__file__).parent.parent.parent / "data" / "resultados.json"


def editar_word(caminho_template: str, caminho_saida: str) -> None:
    """Passo 5 — preenche o template Word com os dados de resultados.json."""
    with open(RESULTS_FILE, encoding="utf-8") as f:
        dados = json.load(f)

    # TODO: usar python-docx para abrir o template e preencher os campos
    # Exemplo:
    # from docx import Document
    # doc = Document(caminho_template)
    # ...
    # doc.save(caminho_saida)

    print(f"[word] Documento gerado em: {caminho_saida}")


if __name__ == "__main__":
    template = sys.argv[1] if len(sys.argv) > 1 else "template.docx"
    saida = sys.argv[2] if len(sys.argv) > 2 else "output.docx"
    editar_word(template, saida)
