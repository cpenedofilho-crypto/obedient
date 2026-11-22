# OBEDIENT Música (app, F3 da decisão D31)

App Expo/React Native do Music Intelligence Engine. Lê a frequência cardíaca por Bluetooth, decide **no
aparelho** com `@obedient/music-engine` e toca o catálogo próprio. Licença AGPL-3.0-only, como o motor.

## Estado

| Peça | Situação |
|---|---|
| Sensor BLE (Heart Rate Service 0x180D) | Escrito e testado com rádio falso. **Desligado por padrão**: só aparece com `EXPO_PUBLIC_SINAL_REAL=1`, porque a D31 proíbe dado real antes do fim da F0 |
| Sinal simulado em tempo real | Ligado: é o modo de demonstração |
| Player (dois canais do expo-audio, crossfade só de volume) | Escrito e testado com canal falso |
| Catálogo de demonstração | 10 faixas geradas no próprio aparelho (WAV sintético); nenhuma música de terceiros |
| Consentimento destacado, ajustes, controles manuais, trilha, exportar e apagar | Telas prontas; lógica no controlador, testada no Node |
| Growth OS (F2, casa-de-ia#214) | Cliente pronto e testado; **sem login ainda** (Supabase Auth no app é pendência), então o app não chama servidor |
| Build nativo (APK/IPA) | **Não feito**: o ambiente de desenvolvimento não tem Android SDK nem Xcode. O bundle JS de Android e iOS compila no CI |

## Comandos

```bash
npm ci
npm run typecheck
npm test             # controlador, sensor BLE, mixer, cliente, shim de node:crypto, textos
npm run licenses     # portão de licenças do OBEDIENT sobre o lockfile do app
npx expo export --platform android --output-dir dist-export/android
```

Para rodar num celular (fora do CI): `npx expo prebuild` e `npx expo run:android` (ou `run:ios`), com
Android Studio ou Xcode instalados. O BLE não funciona no Expo Go nem em simulador.

## Arquitetura

```
App.tsx ── portas do celular ──▶ src/treino/controlador.ts ──▶ @obedient/music-engine (SessaoMusical)
            │                          │
            ├ plataforma/ble-plx.ts    ├ sensor/ble.ts (SensorBle)  ou  sensor/simulado-tempo-real.ts
            ├ plataforma/canal-expo-audio.ts ─▶ player/mixer.ts (PlayerNativo)
            ├ plataforma/kv-async-storage.ts ─▶ armazenamento/ (ConsentStore do Ethics Engine no aparelho)
            └ plataforma/arquivos-demo.ts    ─▶ catalogo/ (WAV sintético)
```

- `node:crypto` não existe no React Native. Os pacotes do núcleo o importam no topo, então o Metro troca
  o import por `shims/node-crypto.ts`: SHA-256, `randomUUID` e `timingSafeEqual`, conferidos contra o
  Node no teste.
- O que nunca sai do aparelho:
  - frequência cardíaca;
  - FC de repouso e máxima;
  - trilha de decisões.
- Ao servidor só vão:
  - as preferências declaradas;
  - a prova de consentimento;
  - o resumo de contagens, e só com o consentimento de agregados.
- A guarda de desenho (`packages/music-engine/src/guarda-de-desenho.test.ts`) também varre este app.

## Pendências

1. **Parecer da F0** (`docs/governance/music-engine-f0.md`), em especial AGPL × lojas, antes de qualquer
   distribuição e antes de ligar o sensor real.
2. **Login (Supabase Auth)** para sincronizar com o Growth OS.
3. **Catálogo real com arquivos** (F4). Hoje o app só toca a demonstração.
4. **Build e teste em aparelho:**
   - Android com foreground service durante o treino;
   - iOS com áudio e Bluetooth em segundo plano;
   - medição de bateria e latência (meta p95 < 50 ms por amostra).
