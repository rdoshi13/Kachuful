import { GameClient } from "../components/GameClient";

export default function Page() {
  return (
    <main className="app-shell">
      <header className="app-shell__header">
        <div className="brand">
          <div aria-hidden="true" className="brand-mark">
            <span className="brand-mark__card" />
            <span className="brand-mark__pip">♠</span>
          </div>
          <div>
            <p className="brand__eyebrow">Online Card Game</p>
            <h1 className="brand__title">Kachuful Multiplayer</h1>
          </div>
        </div>
      </header>
      <GameClient />
    </main>
  );
}
