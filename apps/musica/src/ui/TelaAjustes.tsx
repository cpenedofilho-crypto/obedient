// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Ajustes: frequência de repouso e máxima (ficam só no aparelho), modo da adaptação, explícito e prazo
// da trilha local. O app não estima a frequência máxima pela idade.
import { useState } from "react";
import { TextInput, View } from "react-native";
import type { ControladorDoTreino, Visao } from "../treino/controlador.ts";
import { Botao, Cartao, estilos, Texto, useCores } from "./base.tsx";
import { ERRO_AJUSTE } from "./textos.ts";

const MODOS = [["ligada", "Adaptar sozinho"], ["so_sugestao", "Só sugerir"], ["desligada", "Desligado"]] as const;

export function TelaAjustes({ c, v }: { c: ControladorDoTreino; v: Visao }) {
  const cores = useCores();
  const [repouso, setRepouso] = useState(v.ajustes.fcRepouso?.toString() ?? "");
  const [maxima, setMaxima] = useState(v.ajustes.fcMaxima?.toString() ?? "");
  const [modo, setModo] = useState(v.ajustes.preferencias.modo);
  const [explicito, setExplicito] = useState(v.ajustes.preferencias.permiteExplicito);
  const [retencao, setRetencao] = useState(String(v.ajustes.retencaoTrilhaH));
  const [erros, setErros] = useState<string[]>([]);
  const [salvo, setSalvo] = useState(false);
  const campo = { borderWidth: 1, borderColor: cores.borda, borderRadius: 8, padding: 12, color: cores.texto, minHeight: 48, fontSize: 16 };
  const numero = (s: string) => (s.trim() === "" ? null : Number(s));

  async function salvar() {
    const e = await c.salvarAjustes({
      ...v.ajustes,
      fcRepouso: numero(repouso), fcMaxima: numero(maxima), retencaoTrilhaH: Number(retencao),
      preferencias: { ...v.ajustes.preferencias, modo, permiteExplicito: explicito },
    });
    setErros(e);
    setSalvo(e.length === 0);
  }

  return (
    <View>
      <Cartao titulo="Sua frequência cardíaca">
        <Texto fraco>Ficam só neste aparelho. Use valores de um teste ou da orientação de um profissional.</Texto>
        <Texto>Repouso (bpm)</Texto>
        <TextInput accessibilityLabel="Frequência cardíaca de repouso em batimentos por minuto" keyboardType="number-pad" value={repouso} onChangeText={setRepouso} style={campo} />
        <Texto>Máxima (bpm)</Texto>
        <TextInput accessibilityLabel="Frequência cardíaca máxima em batimentos por minuto" keyboardType="number-pad" value={maxima} onChangeText={setMaxima} style={campo} />
      </Cartao>
      <Cartao titulo="Adaptação">
        <View style={estilos.linha}>
          {MODOS.map(([m, rotulo]) => <Botao key={m} rotulo={rotulo + (modo === m ? " ✓" : "")} tipo={modo === m ? "principal" : "comum"} aoTocar={() => setModo(m)} />)}
        </View>
        <Botao rotulo={explicito ? "Conteúdo explícito: permitido" : "Conteúdo explícito: bloqueado"} aoTocar={() => setExplicito(!explicito)} />
      </Cartao>
      <Cartao titulo="Trilha local">
        <Texto fraco>Por quantas horas guardar o porquê de cada troca (0 = não guardar).</Texto>
        <TextInput accessibilityLabel="Horas para guardar a trilha local" keyboardType="number-pad" value={retencao} onChangeText={setRetencao} style={campo} />
      </Cartao>
      {erros.map((e) => <Texto key={e}>{ERRO_AJUSTE[e] ?? e}</Texto>)}
      {salvo ? <Texto fraco>Ajustes salvos.</Texto> : null}
      <Botao rotulo="Salvar" tipo="principal" aoTocar={() => void salvar()} />
    </View>
  );
}
