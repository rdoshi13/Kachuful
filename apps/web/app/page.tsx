import { GameClient } from "../components/GameClient";

export default function Page() {
  return (
    <main>
      <section>
        <h1>Kachuful Multiplayer</h1>
        <p>Private room gameplay with server-authoritative rules.</p>
      </section>
      <GameClient />
    </main>
  );
}
