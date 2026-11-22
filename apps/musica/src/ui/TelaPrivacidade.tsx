// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Privacidade: a trilha local (por que cada troca), exportar tudo o que o aparelho guarda e apagar tudo.
import { useState } from "react";
import { Alert, Share, View } from "react-native";
import type { ControladorDoTreino } from "../treino/controlador.ts";
import { Botao, Cartao, Texto } from "./base.tsx";
import { MOTIVO } from "./textos.ts";

export function TelaPrivacidade({ c }: { c: ControladorDoTreino }) {
  const [aviso, setAviso] = useState<string | null>(null);
  const trilha = c.trilhaLocal().slice(-30).reverse();

  async function exportar() {
    const dados = await c.exportarDoAparelho();
    await Share.share({ title: "Meus dados da música adaptativa", message: JSON.stringify(dados, null, 2) });
  }

  function apagar() {
    Alert.alert("Apagar meus dados", "Revoga os consentimentos, para o treino e apaga tudo o que o app guardou. Com login, pede o mesmo ao servidor.", [
      { text: "Cancelar", style: "cancel" },
      { text: "Apagar", style: "destructive", onPress: () => void c.apagarMeusDados().then((r) => setAviso(r.servidor === "falhou" ? "Apagado no aparelho. O servidor não respondeu: tente de novo depois." : "Tudo apagado.")) },
    ]);
  }

  return (
    <View>
      <Cartao titulo="Por que a música mudou">
        {trilha.length ? trilha.map((r, i) => <Texto key={`${r.em}-${i}`} fraco>{`${r.em.slice(11, 19)} · ${MOTIVO[r.motivo]}${r.faixaId ? ` (${r.faixaId})` : ""}`}</Texto>) : <Texto fraco>Nada guardado.</Texto>}
      </Cartao>
      <Cartao titulo="Seus dados">
        <Texto fraco>A frequência cardíaca nunca sai deste aparelho. A trilha não guarda bpm.</Texto>
        <Botao rotulo="Exportar meus dados" aoTocar={() => void exportar()} />
        <Botao rotulo="Apagar meus dados" tipo="perigo" aoTocar={apagar} />
        {aviso ? <Texto>{aviso}</Texto> : null}
      </Cartao>
    </View>
  );
}
