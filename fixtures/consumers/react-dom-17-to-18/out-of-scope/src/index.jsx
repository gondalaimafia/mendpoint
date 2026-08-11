import React from "react";
import ReactDOM from "react-dom";
import App from "./App";

// React 18 removed the third callback argument accepted by the legacy render
// entry point. There is no deterministic single expression it maps to, so
// analysis must report this file as out-of-scope and abstain rather than
// producing a wrong edit.
ReactDOM.render(<App name="world" />, document.getElementById("root"), () => {
  console.log("rendered");
});
