import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing desktop root element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
