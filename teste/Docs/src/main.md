# main.tsx — Application Entry Point

## Visão Geral

Entry point do Vite/React. Monta o componente `App` dentro do elemento `#root` do `index.html`, wrappado em `StrictMode`.

`StrictMode` causa double-render em desenvolvimento para detectar side effects indesejados — relevante para os `useEffect` de validação de cupom no `OrderForm`.
