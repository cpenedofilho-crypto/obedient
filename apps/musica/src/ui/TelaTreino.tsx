// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Treino: escolher o sensor (simulado, ou a cinta real quando liberado), começar e parar, ver zona,
// fase e o porquê da última decisão, e os controles manuais, que sempre vencem o motor.
import { useState } from "react";
import { View } from "react-native";
import type { SensorAdapter } from "@obedient/music-contracts";
import type { ControladorDoTreino, Visao } from "../treino/controlador.ts";
import { SINAL_REAL_LIBERADO } from "../config.ts";
import type { AparelhoBle } from "../sensor/ble.ts";
import { Botao, Cartao, estilos, Texto } from "./base.tsx";
import { ERRO_INICIO, FASE, MOTIVO, ZONA } from "./textos.ts";

export interface FontesDeSensor {
  simulado(): SensorAdapter;
  procurar(): Promise<AparelhoBle[] | "sem_permissao" | "bluetooth_desligado">;
  real(id: string): SensorAdapter;
}

export function TelaTreino({ c, v, sensores }: { c: ControladorDoTreino; v: Visao; sensores: FontesDeSensor }) {
  const [aviso, setAviso] = useState<string | null>(null);
  const [aparelhos, setAparelhos] = useState<AparelhoBle[]>([]);
  const s = v.sessao;

  async function comecar(sensor: SensorAdapter) {
    const e = await c.iniciarTreino(sensor);
    setAviso(e ? ERRO_INICIO[e] ?? e : null);
  }

  async function procurar() {
    setAviso("Procurando sensores de frequência cardíaca…");
    const r = await sensores.procurar();
    if (r === "sem_permissao") return setAviso("Sem permissão de Bluetooth.");
    if (r === "bluetooth_desligado") return setAviso("Ligue o Bluetooth.");
    setAparelhos(r);
    setAviso(r.length ? null : "Nenhum sensor encontrado. Ligue a cinta ou o modo de transmissão do relógio.");
  }

  if (!v.emTreino) {
    return (
      <View>
        <Cartao titulo="Começar treino">
          <Botao rotulo="Treino de demonstração (sinal simulado)" tipo="principal" aoTocar={() => void comecar(sensores.simulado())} />
          {SINAL_REAL_LIBERADO ? (
            <>
              <Botao rotulo="Procurar cinta ou relógio" aoTocar={() => void procurar()} />
              {aparelhos.map((a) => <Botao key={a.id} rotulo={`Usar ${a.nome ?? a.id}`} aoTocar={() => void comecar(sensores.real(a.id))} />)}
            </>
          ) : (
            <Texto fraco>O sensor real fica desligado até o parecer jurídico da F0 (decisão D31). Por enquanto, só o sinal simulado.</Texto>
          )}
          {aviso ? <Texto>{aviso}</Texto> : null}
        </Cartao>
        {v.resumosPendentes ? <Texto fraco>{`${v.resumosPendentes} resumo(s) esperando rede para enviar.`}</Texto> : null}
      </View>
    );
  }

  const ctx = s?.contexto;
  const decisao = s?.ultimaDecisao;
  return (
    <View>
      <Cartao titulo="Agora">
        <Texto grande>{ctx?.zona ? ZONA[ctx.zona] : "Esperando sinal…"}</Texto>
        <Texto fraco>{ctx ? `${FASE[ctx.fase]}${ctx.bpmSuavizado ? ` · ${Math.round(ctx.bpmSuavizado)} bpm` : ""}` : ""}</Texto>
        <Texto>{s?.tocando ? `Tocando: ${s.tocando.faixaId}` : "Nada tocando"}</Texto>
        {decisao ? <Texto fraco>{MOTIVO[decisao.motivo]}</Texto> : null}
      </Cartao>
      {v.sugestao ? (
        <Cartao titulo="Sugestão">
          <Botao rotulo={`Tocar ${v.sugestao}`} tipo="principal" aoTocar={() => void c.aceitarSugestao(v.sugestao!)} />
        </Cartao>
      ) : null}
      <Cartao titulo="Você manda">
        <View style={estilos.linha}>
          {s?.travas.pausado ? <Botao rotulo="Retomar adaptação" aoTocar={() => c.retomar()} /> : <Botao rotulo="Pausar adaptação" aoTocar={() => c.pausar()} />}
          {s?.travas.faixaTravada
            ? <Botao rotulo="Destravar música" aoTocar={() => c.travarFaixa(null)} />
            : <Botao rotulo="Travar esta música" desligado={!s?.tocando} aoTocar={() => c.travarFaixa(s?.tocando?.faixaId ?? null)} />}
          {s?.travas.zonaTravada
            ? <Botao rotulo={`Destravar ${ZONA[s.travas.zonaTravada]}`} aoTocar={() => c.travarZona(null)} />
            : <Botao rotulo="Travar zona atual" desligado={!ctx?.zona} aoTocar={() => c.travarZona(ctx?.zona ?? null)} />}
        </View>
      </Cartao>
      <Botao rotulo="Parar treino" tipo="perigo" aoTocar={() => void c.pararTreino()} />
    </View>
  );
}
