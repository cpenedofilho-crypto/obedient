// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Cláudio Penedo.
// Conta: entrar por link mágico (sem senha), escolher a organização quando houver mais de uma, sair.
// Sem login o app segue no modo demonstração; com login, sincroniza com o Growth OS da organização.
import { useState } from "react";
import { TextInput, View } from "react-native";
import type { EstadoConta } from "../auth/conta.ts";
import { Botao, Cartao, Texto, useCores } from "./base.tsx";

export interface AcoesConta {
  pedirLink(email: string): Promise<string | null>;
  escolher(slug: string): Promise<void>;
  sair(): Promise<void>;
}

const ERRO: Record<string, string> = {
  email_invalido: "Confira o e-mail.",
  recusado: "Se este e-mail tiver acesso, o link chega em instantes. Confira também o spam.",
  sem_rede: "Sem conexão. Tente de novo.",
};

export function TelaConta({ estado, acoes, configurado }: { estado: EstadoConta; acoes: AcoesConta; configurado: boolean }) {
  const cores = useCores();
  const [email, setEmail] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);

  if (!configurado) {
    return <Cartao titulo="Conta"><Texto fraco>Login não configurado neste build. O app segue no modo demonstração.</Texto></Cartao>;
  }
  if (estado.tipo === "fora") {
    return (
      <Cartao titulo="Entrar">
        <Texto fraco>Você recebe um link por e-mail. Abra o link neste mesmo celular. Não há senha.</Texto>
        <TextInput accessibilityLabel="E-mail" autoCapitalize="none" autoComplete="email" keyboardType="email-address" value={email} onChangeText={setEmail}
          style={{ borderWidth: 1, borderColor: cores.borda, borderRadius: 8, padding: 12, color: cores.texto, minHeight: 48, fontSize: 16 }} />
        <Botao rotulo="Enviar link" tipo="principal" aoTocar={() => void acoes.pedirLink(email).then((e) => setAviso(e ? ERRO[e] ?? e : "Link enviado. Abra o e-mail neste celular."))} />
        {aviso ? <Texto>{aviso}</Texto> : null}
      </Cartao>
    );
  }
  const quem = estado.usuario.email ?? estado.usuario.id;
  return (
    <View>
      <Cartao titulo="Conta">
        <Texto>{`Entrou como ${quem}`}</Texto>
        {estado.tipo === "dentro" ? <Texto fraco>{`Organização: ${estado.organizacao.nome}`}</Texto> : null}
        {estado.tipo === "sem_organizacao" ? <Texto>{`Sem acesso à música em nenhuma organização. Peça ao administrador. Seu id: ${estado.usuario.id}`}</Texto> : null}
        {estado.tipo === "sem_rede" ? <Texto fraco>Sem conexão com o Growth OS. O app segue com o que já está no aparelho.</Texto> : null}
      </Cartao>
      {estado.tipo === "escolher" ? (
        <Cartao titulo="Escolha a organização">
          {estado.organizacoes.map((o) => <Botao key={o.slug} rotulo={o.nome} aoTocar={() => void acoes.escolher(o.slug)} />)}
        </Cartao>
      ) : null}
      <Botao rotulo="Sair" tipo="perigo" dica="Encerra a sessão e apaga as músicas baixadas da organização" aoTocar={() => void acoes.sair()} />
    </View>
  );
}
