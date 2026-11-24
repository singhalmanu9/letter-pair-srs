import { h, render } from "preact";
import { registerSW } from "virtual:pwa-register";
import { App } from "./ui/App";
import "./ui/styles.css";

render(h(App, {}), document.getElementById("app")!);

// Offline support and silent updates when a new version is deployed.
registerSW({ immediate: true });
