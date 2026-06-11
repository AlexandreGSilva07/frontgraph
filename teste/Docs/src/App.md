# App.tsx — Root Component

## Visão Geral

Componente raiz da aplicação. É um shell mínimo que renderiza `OrderForm` dentro de uma div com classe `app`.

Não contém lógica de negócio, estado, ou props. Existe apenas como ponto de montagem para o wizard de pedidos.

A div wrapper `.app` aplica max-width (720px), centralização e padding via CSS.
