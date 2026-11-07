# Pilot: proverljiv oporavak plaćenog pristupa

Reconcile je predlog dodatka za Adapty support/integration tim i developere
aplikacija koje koriste Adapty. Demo dokazuje lokalnu tehničku putanju; spremnost
kupca da plati još nije potvrđena. Nema dogovorenog partnerstva ili pristupa
internim Adapty alatima.

## Problem koji proveravamo

Potvrđena, važeća kupovina može da postoji kod payment providera, dok Adapty
aktivacija ili klijentski pristup izostaju. Podrška tada povezuje više izvora i
ručno proverava pojedinačne naloge. Adapty dokumentuje probleme sa povezivanjem
proizvoda/cena i postojeće operacije naknadne validacije:
[store sync](https://adapty.io/docs/store-sync),
[Stripe validation](https://adapty.io/docs/api-adapty/operations/validateStripePurchase),
[Paddle validation](https://adapty.io/docs/api-adapty/operations/validatePaddlePurchase).

Proveravamo da li objedinjena dijagnostika, individualno potvrđen blast radius,
odobren plan i dokaz stvarnog gate-a skraćuju taj posao. Ne prodajemo novu naplatu
niti već naplaćen iznos nazivamo recovered revenue. Generička outage zaštita nije
dovoljna razlika: [RevenueCat reliability](https://www.revenuecat.com/feature/reliability)
već opisuje privremena prava i naknadno usklađivanje.

## Prvi razgovor sa Adapty timom

1. Koje vrste paid-but-not-activated incidenata se ponavljaju i koliko istraga
   zahtevaju? Tražimo anonimizovane primere i agregate, bez payment tajni.
2. Šta već detektuju interni alati? Gde zaista ostaje ručni posao između payment
   zapisa, Adapty profila i klijentskog backend-a?
3. Koje recovery operacije smeju grupno da se izvršavaju, ko ih odobrava i kako
   proveriti identitet, refund, važenje perioda i promenjenu konfiguraciju?
4. Ko bi bio vlasnik integracije i kupac: Adapty, developer aplikacije ili oba?
   Da li su spremni da ulože vreme u pilot i po kom merljivom ishodu bi ga kupili?

## Predloženi pilot i merila

Prva faza je read-only replay istorijskih, anonimizovanih slučajeva. Tim unapred
beleži očekivani obuhvat i zaključak; Reconcile dobija samo operativne izvore.
Poređenje sa podrškom razlikuje potvrđene slučajeve, netačne alarme i nedovoljnu
evidenciju. Tek zatim sledi sandbox recovery uz eksplicitno odobrenje i stvarni
klijentski probe.

| Mera | Kako je beležimo | Predlog kriterijuma za pilot |
| --- | --- | --- |
| Neodobrene ili pogrešne dodele | Uporediti svaku akciju sa identitetom, periodom i odobrenim planom | Nula; svaki nalaz zaustavlja write deo |
| Tačnost potvrđenog obuhvata | Nezavisno označeni slučajevi naspram potvrđenih naloga | Dogovoriti cilj pre pilota; objaviti i propuštene slučajeve |
| Nepotpuna evidencija | Broj i razlog inconclusive naloga, nedostajući izvori | Nijedan takav nalog ne dobija automatski repair |
| Vreme do dijagnoze | Od prvog signala do objašnjenja i individualno potvrđenog obuhvata | Uporediti medijanu i najsporije slučajeve sa ručnim postupkom |
| Vreme do oporavka | Od odobrenja do svežeg Adapty readback-a i client probe-a | Meriti odvojeno aktivaciju i pristup |
| Ručni koraci | Radnje operatora po incidentu i nalogu | Merljivo smanjenje bez skrivanja potrebne kontrole |
| Integracioni napor | Sati za izvore, identitet, adapter i gate probe | Dogovoriti prihvatljiv budžet sa developerom |
| Spremnost za kupovinu | Imenovan vlasnik budžeta i konkretan sledeći komercijalni korak | Obaveza za plaćeni pilot ili jasan uslov za njega |

Ovo su predložena merila, ne već ostvareni poslovni rezultati. Pragove ne
prilagođavamo naknadno da bi demo izgledao uspešno.

## Odgovornost i granice

Payment provider potvrđuje kupovinu; Adapty upravlja svojim profilom/aktivacijom;
developer poseduje identitet, klijentsku projekciju i gate. Reconcile čuva
evidenciju, klasifikuje, predlaže, izvršava samo odobreni scope i proverava ishod.
Operator odobrava konkretan plan. Nejasno vlasništvo transakcije blokira writes.

Pre live faze treba potvrditi sandbox ugovore, credential isolation, retention,
rate limits, mrežne timeout-e, operativno praćenje i on-call odgovornost. Native
mobilne biblioteke dolaze posle toga. Aktuelna iteracija je lokalni mock, sa
izvršivim Python server SDK-om i mobilnim ugovorom/simulatorom.
