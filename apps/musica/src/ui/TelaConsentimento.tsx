// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Consentimento destacado e específico (LGPD art. 11, I). Duas finalidades separadas; a segunda é opcional.
import type { ControladorDoTreino, Visao } from "../treino/controlador.ts";
import { VERSAO_TEXTO } from "../treino/controlador.ts";
import { Botao, Cartao, estilos, Texto } from "./base.tsx";
import { TEXTO_CONSENTIMENTO_AGREGADOS, TEXTO_CONSENTIMENTO_SINAL } from "./textos.ts";
import { View } from "react-native";

export function TelaConsentimento({ c, v }: { c: ControladorDoTreino; v: Visao }) {
  return (
    <View>
      <Cartao titulo="Música pelo seu esforço">
        <Texto>{TEXTO_CONSENTIMENTO_SINAL}</Texto>
        <Texto fraco>{`Situação: ${v.sinalPermitido ? "autorizado" : "não autorizado"} · texto ${VERSAO_TEXTO}`}</Texto>
        <View style={estilos.linha}>
          {v.sinalPermitido
            ? <Botao rotulo="Revogar" tipo="perigo" aoTocar={() => void c.consentirSinal(false)} dica="Para a leitura do sensor na hora" />
            : <Botao rotulo="Autorizo, especificamente" tipo="principal" aoTocar={() => void c.consentirSinal(true)} dica="Autoriza ler a frequência cardíaca só para escolher a música" />}
        </View>
      </Cartao>
      <Cartao titulo="Resumo para a organização (opcional)">
        <Texto>{TEXTO_CONSENTIMENTO_AGREGADOS}</Texto>
        <Texto fraco>{`Situação: ${v.agregadosPermitidos ? "autorizado" : "não autorizado"}`}</Texto>
        <View style={estilos.linha}>
          {v.agregadosPermitidos
            ? <Botao rotulo="Revogar resumo" tipo="perigo" aoTocar={() => void c.consentirAgregados(false)} />
            : <Botao rotulo="Autorizo enviar o resumo" aoTocar={() => void c.consentirAgregados(true)} />}
        </View>
      </Cartao>
    </View>
  );
}
