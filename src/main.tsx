import "bootstrap/dist/css/bootstrap.min.css";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";

import { PyodideH5Provider } from "./contexts/PyodideH5Context";

import { HomePage } from "./pages/HomePage";
import { AnalyzePage } from "./pages/AnalyzePage";
import { EditPage } from "./pages/EditPage";
import { ViewPage } from "./pages/ViewPage";

const router = createBrowserRouter([
  { path: "/", Component: HomePage },
  { path: "/analyze", Component: AnalyzePage },
  { path: "/edit", Component: EditPage },
  { path: "/view", Component: ViewPage },
]);

createRoot(document.getElementById("root")!).render(
  <PyodideH5Provider>
    <RouterProvider router={router} />
  </PyodideH5Provider>,
);
