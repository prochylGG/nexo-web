# NEXO — wersja internetowa z kontami

To jest działający szkielet aplikacji internetowej: wymagane logowanie/rejestracja, hasła haszowane bcrypt, sesje przechowywane w PostgreSQL, wyszukiwanie użytkownika po dokładnej nazwie, zaproszenia do znajomych i prywatne wiadomości tekstowe.

## Wymagania
- Node.js 20+
- PostgreSQL (np. baza PostgreSQL utworzona w Render)

## Uruchomienie lokalne
1. Zainstaluj Node.js 20+ i PostgreSQL.
2. Skopiuj `.env.example` do `.env` i uzupełnij `DATABASE_URL` oraz `SESSION_SECRET`.
3. Wygeneruj sekret poleceniem `openssl rand -base64 48` i wklej go jako `SESSION_SECRET`.
4. Uruchom `npm install`, a potem `npm start`.
5. Otwórz `http://localhost:3000`.

## Publikacja przez GitHub + Render
1. Utwórz repozytorium GitHub, np. `nexo-web`, i wgraj zawartość tego folderu.
2. W Render utwórz **PostgreSQL**. Skopiuj Internal Database URL (jeśli web service i baza są w tym samym regionie) albo External Database URL.
3. W Render wybierz **New + → Web Service**, połącz repozytorium.
4. Ustaw: **Build Command:** `npm install`; **Start Command:** `npm start`; **Runtime:** Node.
5. W Environment dodaj `DATABASE_URL` (URL z PostgreSQL), `SESSION_SECRET` (losowy długi sekret), `NODE_ENV=production` i `COOKIE_SECURE=true`.
6. Wdróż usługę. Po otrzymaniu adresu HTTPS otwórz go i zarejestruj konto.

Nie commituj `.env` ani haseł do GitHuba. Baza danych musi być trwała; nie zastępuj PostgreSQL ulotnym plikiem SQLite na hostingu.

## Co działa i czego jeszcze brakuje
- Działa: konta e-mail + hasło, unikalna nazwa użytkownika, sesja logowania, wylogowanie, szukanie po nazwie, zaproszenia, akceptowanie zaproszeń, czaty tekstowe między zaakceptowanymi znajomymi.
- „E-mail” oznacza adres użyty przy rejestracji; w tej wersji nie ma jeszcze logowania Google OAuth ani weryfikacji e-mail/SMS.
- Nie ma jeszcze WebRTC (połączenia głosowe/wideo/udostępnianie ekranu), wysyłania obrazów/GIF-ów, resetowania hasła ani weryfikacji e-mail. Nie udostępniaj tej wersji szeroko przed dodaniem tych funkcji i przeglądem bezpieczeństwa.
