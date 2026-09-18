# Como o SharedArc funciona

O SharedArc é um fluxo de USDC compartilhado para um coletivo: **uma taxa, N shares, uma autonomia ao vivo**. Uma
pool pré-financiada flui `ratePerSecond` de USDC, dividido entre os membros por shares inteiros e mutáveis.
Entrar, sair ou mudar de peso no meio do fluxo é uma escrita O(1) que não toca no armazenamento de mais ninguém.

Tudo nesta página é o que o contrato `DripPool` faz de verdade. Os números que correm no app vêm da mesma
aritmética, espelhada no `@sharedarc/sdk`, então quem vê o próprio saldo encher está vendo a chain, não uma
estimativa.

## O acúmulo, por inteiro

O tempo entra no contrato em um único lugar. Toda função que muda estado chama `_accrue` antes de mexer na taxa,
nos shares, no saldo ou no que é devido.

```
_accrue(p):
  from = max(p.lastAccrual, p.startTime)
  if (now > from && p.ratePerSecond > 0 && p.totalShares > 0):
      available = p.balance * WAD_PER_UNIT - p.owed          // wad ainda não fluído
      dt        = min(now - from, available / p.ratePerSecond) // piso: é aqui que congela
      streamed  = p.ratePerSecond * dt
      p.accIndex += streamed * INDEX_SCALE / p.totalShares     // piso
      p.owed     += streamed
  p.lastAccrual = now

_settle(p, m):  // sempre logo depois de _accrue
  m.pending += m.shares * (p.accIndex - m.index) / INDEX_SCALE // piso
  m.index    = p.accIndex
```

O `accIndex` é o truque todo. Ele conta quanto um share ganhou desde que a pool foi criada. O `index` de cada
membro guarda onde esse contador estava na última vez que ele foi liquidado, então a diferença vezes os shares
dele é o que ele ganhou, aconteça o que acontecer com os outros nesse meio-tempo. Adicionar um membro é uma
escrita. Mudar o peso de um membro reprecifica a pool inteira daquele segundo em diante, e custa a mesma escrita.

Os valores ficam em **wad** (unidades de USDC × 1e12, ou seja, 18 casas) para que uma taxa pequena como 1 USDC
por mês — cerca de 3,9e-7 USDC por segundo — não arredonde para zero. As transferências continuam em unidades
inteiras de USDC: o resto abaixo de uma unidade fica em `pending` e sai no próximo saque.

### Um exemplo completo

Uma pool flui 3 USDC/dia. Os membros são A com 1 share, B com 1 e C com 2. Alguém deposita 1 USDC.

| Momento | O que acontece |
|---|---|
| t = 0 | 1 USDC banca 8 horas a 3 USDC/dia. A autonomia mostra "8 h 00 m". |
| t = 4 h | 0,5 USDC fluiu: A 0,125, B 0,125, C 0,25. |
| t = 4 h | A dona adiciona D com 1 share. A, B e C são liquidados antes, então os 0,5 USDC deles ficam intactos. Daí em diante a divisão é 1/1/2/1. |
| t = 8 h | A pool esvaziou. O `dt` é limitado pelo tempo financiado, então o acúmulo para sozinho: **congelado**. O valor sacável para de crescer, e ninguém é credor de mais do que a pool tem. |
| t = 20 h | Alguém deposita 5 USDC. O fluxo volta **a partir do timestamp do próprio depósito**. As 12 horas congeladas não são pagas depois. |

## O que é garantido

| Garantia | Como se sustenta |
|---|---|
| Uma pool nunca pode dever mais do que tem | O `dt` é limitado por `available / ratePerSecond`, então o acúmulo para no segundo exato em que os fundos acabam. Invariante I2: `owed ≤ balance × 1e12`. |
| A dona nunca toca no que já foi ganho | `withdrawUnstreamed` e `cancel` são limitados por `balance − ceilDiv(owed, 1e12)`. Invariante I4: nenhuma ação da dona reduz o sacável de um membro. |
| Sair não faz perder nada | `setShares(membro, 0)` liquida antes. O que já acumulou continua sacável para sempre, inclusive depois do cancelamento. |
| O arredondamento nunca paga a mais | Toda divisão usa piso, e todo piso favorece a pool. A diferença é poeira que fica em `owed`, limitada a menos de 1 wad por acúmulo. |
| Um membro sem gas ainda recebe | `withdrawFor(poolId, membro)` é sem permissão e sempre envia para o endereço de pagamento do membro. Quem chama paga o gas e não recebe nada. |
| Um membro bloqueado não trava os outros | O `withdrawForBatch` envolve cada transferência em um `try`. Uma transferência que falha é revertida só para aquele membro e reportada como `WithdrawSkipped`; o lote nunca reverte. |

O que **não** é garantido, e é dito com todas as letras: isto é uma folha de pagamento, então a dona pode pausar
(`setRate(0)`), repesar ou cancelar quando quiser. Os membros estão protegidos quanto ao passado, nunca quanto
ao futuro.

## Status

| Status | Significado |
|---|---|
| Agendado | O `startTime` está no futuro. Nada acumula ainda e nenhum fundo é consumido. |
| Fluindo | Os fundos estão indo para os membros a cada segundo. |
| Pausado | A taxa é zero, ou a pool não tem shares. Nada acumula, nada é consumido. |
| Congelado | A pool ficou sem fundos. Volta no próximo depósito, sem pagar o tempo parado. |
| Cancelado | Parou de vez. Os membros continuam sacando o que ganharam, para sempre. |

## Coloque um Safe, ou qualquer DAO, como dona

A dona da pool é um `address` comum. Pode ser uma EOA, um Safe, um contrato de governança ou a carteira de um
agente — o contrato não tem governança embutida, nem papéis, nem chave de admin própria. Qualquer coisa que
consiga enviar uma transação pode ser dona de uma pool.

A propriedade muda em dois passos: a dona atual chama `transferPoolOwnership`, a nova dona chama
`acceptPoolOwnership`. Nada muda até essa segunda chamada, então um erro de digitação não perde uma pool. O par
continua funcionando em uma pool cancelada.

## Como se compara

| | SharedArc | Streams estilo Sablier | Splitters estilo 0xSplits | Revenue Router do Arc Studio |
|---|---|---|---|---|
| Baseado em tempo | sim | sim | não (divide na chegada) | não |
| Pesos mutáveis | sim, O(1) por mudança | cancelar e recriar N streams | sim | fixos no deploy |
| Um número de autonomia | sim, por pool | espalhado por N saldos | n/a | n/a |
| Adicionar um membro | uma escrita | um stream novo para financiar | uma escrita | redeploy |
| Insolvência | impossível: o fluxo congela | depósitos por stream | n/a | n/a |
| Na Arc | sim | não implantado | não implantado | exemplo de tutorial |

## Perguntas frequentes

**Onde fica o dinheiro?** No singleton `DripPool`, contabilizado por pool. Transferências diretas de USDC para o
contrato são ignoradas pela contabilidade e não podem ser recuperadas — use sempre o `deposit`.

**Quanto custa um saque?** Cerca de 0,002 USDC no piso de 20 gwei da Arc. O gas é pago em USDC, então um membro
que só tem a própria folha consegue sacar sem precisar de nenhum outro ativo.

**Por que às vezes aparece "nada a sacar"?** Os saques movem unidades inteiras de USDC. Abaixo de 0,000001 USDC
ainda não há nada para transferir; o valor não se perde, continua acumulando.

**A pool pode me pagar em outro lugar?** Pode: `setPayoutAddress`. Funciona até com zero shares, que é como um
membro bloqueado pelo emissor do USDC ainda consegue receber o que a pool deve a ele.

**Existe token, taxa ou caminho de upgrade?** Não, não e não. Um contrato imutável, sem chave de admin sobre
ele, sem taxas, sem yield.
