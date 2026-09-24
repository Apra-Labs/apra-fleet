import { Members } from "./pages/Members";

/**
 * Root of the shell SPA. Only the Members page (S1, W1) exists so far; later
 * sprints add routing and the Secrets/Health pages.
 */
export function App() {
  return <Members />;
}
