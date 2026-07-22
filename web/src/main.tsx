import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return (
    <div>
      <h1>person-Agent</h1>
      <p>Web workspace initializing...</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
