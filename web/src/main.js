// Single Vite entry. Everything the CDN used to hand us as a global (React,
// Leaflet, mermaid, htmx, React Flow) now comes from node_modules, so there is
// no importmap, no SRI, and no second copy of React to trip "invalid hook call".
import "./styles.css";
import "./app.js";
import "./flow.js";
