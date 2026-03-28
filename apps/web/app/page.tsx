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
            <p className="brand__eyebrow">Kachuful</p>
            <h1 className="brand__title">Kachuful Multiplayer</h1>
          </div>
        </div>
      </header>
      <section className="app-hero">
        <p className="app-hero__subtitle">
          Private room gameplay with server-authoritative rules.
        </p>
        <div className="app-hero__chips">
          <span className="pill app-hero__chip">Realtime multiplayer</span>
          <span className="pill app-hero__chip">Room code access</span>
          <span className="pill app-hero__chip">Cross-country friendly</span>
        </div>
      </section>
      <GameClient />
    </main>
  );
}
