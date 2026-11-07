# Reconcile Payment Activation Recovery

Predlog pivota zasnovan na proveri javne dokumentacije 7. novembra 2026.
Ovo je izvorna istraživačka specifikacija, ne opis live konektora. Lokalna mock
implementacija i stvarni rezultati ove iteracije opisani su u
[verifikacionom izveštaju](ACTIVATION_VERIFICATION.md); aktuelni ugovori su u
[recovery API dokumentu](RECOVERY_API.md).

Reconcile pronalazi potvrđene kupovine za koje nedostaje očekivana aktivacija,
grupiše pogođene korisnike, vodi odobren oporavak kroz podržane Adapty operacije
i proverava ishod u aplikaciji. Ciljni korisnik je tim koji koristi Adapty uz
web/mobile kupovine i sopstveni backend. Proizvod se sastoji od server konektora,
engine-a i UI-ja; opciona mobilna instrumentacija dopunjuje dokaze.

## Zašto ovaj pivot

Postojeći kod na reviziji `12fad97` demonstrira aktivno izvorno pravo, pogrešnu
klijentsku projekciju, odobren resync i stvarni Lumen gate. To je poslednja deonica
oporavka. Ne demonstrira nezavisnu potvrdu naplate niti kupovinu koja nedostaje
u Adapty-ju. Postojeći collector HMAC potvrđuje poreklo poruke našeg konektora;
ne potvrđuje da je payment provider naplatio kupovinu.

Dokumentovan primer za novi glavni scenario: novi Stripe `price_id` nema
odgovarajući par `product_id` + `price_id` u Adapty katalogu. Stripe može da
prijavi isporučen webhook, a transakcija izostaje. [Adapty store sync](https://adapty.io/docs/store-sync).

To je osnova za hipotezu o proizvodu, ne dokaz koliko se incident često dešava.
Predložena vrednost za Adapty: objedinjena dijagnostika, obuhvat incidenta i
proverljiv oporavak preko njihovih postojećih mehanizama. Potrebno je potvrditi
sa njihovim timom šta već postoji interno i koliko podrške takvi slučajevi troše.

## Tri nezavisna stanja

1. **Provider evidence:** kupovina, identitet, proizvod, period, status i izvor
   potvrde; trenutni refund/revocation podaci kada ih adapter podržava.
2. **Adapty state:** poznati profil, kupovina i odgovarajuće trenutno pravo.
3. **Client state:** lokalna projekcija/cache i odluka stvarnog feature gate-a.

Profil se čita za poznatog customer/profile ID-ja; sam Get profile nije inventar
svih kupovina. [Adapty Get profile](https://adapty.io/docs/api-adapty/operations/getProfile).
Obuhvat skena je unija poznatih klijentskih naloga i dostupnih provider zapisa.
Provider kupovina bez poznatog vlasnika ostaje orphan dokaz, nikada automatski
pripisana nalogu po sličnom emailu. UI prikazuje coverage i rupe u izvorima.

Minimalni normalizovani dokaz:

```text
tenant/app/environment/provider
transaction_id/original_transaction_id/subscription_id
provider_customer_id/app_user_id/identity_status/identity_evidence_ref
product_id/price_or_base_plan_id
payment_state/access_basis/period_start/period_end
amount_minor/currency/refund_or_revocation_state
occurred_at/observed_at/evidence_ref/evidence_hash
```

`access_basis` razlikuje plaćeni period, trial, grace i ručnu dodelu. Nepodržano
stanje ostaje unknown. Ne svoditi sve providere na `paid=true`. Invoice bez
pozitivnog iznosa ili dokaz samo iz aplikacije ne prikazivati kao novu naplatu.
Stripe za standardni subscription tok opisuje `invoice.paid` uz aktivan
subscription; dodatno se proverava aktuelni period i policy.
[Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

## Integracija i granice

Server konektor drži provider credentials i purchase tokene van browsera i
mobilnog SDK-a. Ne prikuplja PAN/CVV niti checkout forme. UI dobija reference i
redigovane dokaze, ne autentikacione tajne. Event journal je dodatni trag;
potrebni su i nezavisni provider readback/backfill kako propušten webhook ne bi
sakrio upravo kupovinu koju tražimo. Obnova se proverava i dok aplikacija ne radi.

Klijent implementira mali eksplicitni ugovor:

```text
listAccounts(cursor)
readAccess(account, feature)
probeAccess(account, feature)
resyncAccess(account, expectedRevision, desiredEntitlementHash, operationKey)
```

Probe prolazi istu autorizacionu putanju kao korisnik, u njegovom kontekstu,
bez trošenja kredita ili izvršavanja skupe funkcije. Potvrđuje pristup toj funkciji,
ne garantuje kvalitet ili uspeh celog servisa. Ako aplikacija nema backend gate,
koristi se potvrda sa uređaja i jasno odvojen status; server ne glumi dokaz uređaja.

Mobilni sloj može prijaviti reference transakcije, promenu profila i odbijen
pristup. Njegovo `purchase_succeeded` je signal za proveru, ne finansijska potvrda.
Apple zahteva poznat transaction identifikator, a Google purchase token za
pojedinačno čitanje. Zato obećanje „vidimo sve kupovine u svakoj aplikaciji bez
integracije“ nije izvodljivo. [Apple API](https://developer.apple.com/documentation/appstoreserverapi),
[Google lifecycle](https://developer.android.com/google/play/billing/lifecycle/subscriptions).

## Mogućnosti po provideru

| Provider | Dokaz | Podržan pravac oporavka | MVP demonstracija |
| --- | --- | --- | --- |
| Stripe | Povezan paid invoice/subscription i aktuelno stanje | Ispravna konfiguracija, Validate Stripe purchase, svež profil | Kompletan mock tok za 100 naloga |
| Paddle | Potvrđena transakcija/subscription i aktuelno stanje | Validate Paddle purchase posle ispravnih preduslova | Mali kompletan mock scenario |
| Apple | Verifikovana transakcija/status za poznat ID | Ispravka konfiguracije, dokumentovani SDK retry/restore kada je primenljiv | Dijagnoza i eksplicitno čekanje potrebnog app/operator koraka |
| Google Play | Token + subscriptionsv2 readback | Odgovarajući SDK restore/sync tok za identifikovan profil | Dijagnoza i čekanje potrebnog app/operator koraka |
| Custom store | Provider-verifikovan zapis sa dokumentovanim lifecycle pravilima | Set transaction za konfigurisani custom store | Jedan ograničen mock ugovor, bez tvrdnje o svim providerima |

Stripe validacija koristi `POST /api/v1/sdk/purchase/stripe/token/validate/`,
sa `customer_user_id` i `sub_...` ili `pi_...` tokenom. Validna kupovina može
uvesti istoriju i napraviti profil; uvoz generiše događaje i ulazi u MTR, pa nije
bezazlen GET. [Validate Stripe purchase](https://adapty.io/docs/api-adapty/operations/validateStripePurchase).

Paddle ima zaseban v2 endpoint i drugačiji payload; prihvata transaction ili
subscription token. [Validate Paddle purchase](https://adapty.io/docs/api-adapty/operations/validatePaddlePurchase).
Custom Set transaction je unos već potvrđenog zapisa, ne nezavisna provera
naplate. Ne koristiti ga kao prečicu za Apple/Google.
[Custom stores](https://adapty.io/docs/custom-store).

Apple dokumentuje izgubljen pristup usled credentials/product konfiguracije i
SDK ponovne pokušaje. [App Store troubleshooting](https://adapty.io/docs/troubleshoot-app-store-integration).
Restore može promeniti vlasništvo/deljenje pristupa; prethodno potvrditi profil
i sharing policy, ne pokretati ga naslepo za ceo cohort.
[Access sharing](https://adapty.io/docs/sharing-paid-access-between-user-accounts/).

## Pravila detekcije

| Zatečeno stanje | Klasifikacija i postupak |
| --- | --- |
| Potvrđen važeći plaćeni period, identitet pouzdan, očekivano Adapty pravo odsutno | ACTIVATION_MISSING; traži konfiguracione dokaze i podržan recovery |
| Aktuelno Adapty pravo postoji, klijentski gate odbija zbog subscription/cache stanja | ACCESS_NOT_DELIVERED; koristi postojeći odobreni resync |
| Nepouzdan identitet, izvor nedostupan/zastareo, nepotpun backfill | INCONCLUSIVE; bez writes |
| Promena tek nastala, unutar konfigurisanog vremena propagacije | AWAITING_SYNC; ponovna provera, bez preuranjenog incidenta |
| Pending payment, neaktivan plaćeni period, druga zabrana pristupa | Bez automatskog aktiviranja; tačan razlog i policy |
| Trial/grace/manual grant sa opravdanim pristupom | Nije dokaz naplate i nije automatski incident |

Nedostajuća kupovina na jednom profilu sama nije dokaz da je nema globalno:
proveriti identitet, transfer/sharing i reference dostupne adapteru. Zajednički
product/price, period i konfiguraciona verzija grupišu sumnjivi obuhvat; svaki
nalog se zatim individualno proverava. „Potvrđen uzrok“ zahteva katalog/config
dokaz; bez njega UI kaže „moguć uzrok“. Katalog se čita ili uvozi uz datum/verziju.

## Plan i izvršavanje

Koraci: detect → preview → approve → preflight → config prerequisite → provider
validation → Adapty readback → client resync → client gate verification.

Konfiguraciona promena je zasebna operacija: može uticati i na buduće kupovine
van izabranih naloga. Trenutni CLI dokumentuje da store/price ID postojećeg
proizvoda nije izmenljiv; za drugi ID pravi se novi proizvod. Ne izmišljati
`updatePriceId` API. U MVP-u operator odobrava simuliranu katalog-promenu; buduća
live verzija bira potvrđen CLI/dashboard workflow uz poseban scope i credentials.
[Adapty products CLI](https://adapty.io/docs/developer-cli-products).

Plan sadrži tačan cohort, evidence/config hash, identitet, period, odabranu
operaciju, policy, TTL i očekivanu lokalnu reviziju. Preflight ponovo čita izvor.
Timeout spoljne operacije znači unknown outcome: prvo readback, zatim odluka o
retry-ju. Lokalni operation key nije obećanje da provider podržava exactly-once.
Čuvati rezultate po koraku; uspešna validacija ne poništava se zato što je
klijentski cache zakazao. Retry radi samo preostali potrebni korak.

Odvojeni rezultati: `activation_verified`, `client_access_verified`,
`awaiting_client_action`, `blocked_configuration`, `inconclusive`, `unresolved`.
HTTP200 validacije nije dovoljan za zelen status. Ručni grant nije rekonstrukcija
plaćene kupovine i ne sme zatvarati activation incident kao oporavljen payment.
[Manual access grants](https://adapty.io/docs/server-side-api-with-ai).

## Glavni hackathon demo

Sve ostaje lokalno i sintetičko. Ovo je NOV scenario; postojeći cancellation
scenario ostaje regresiona kontrola.

1. Mock provider obradi kupovine 100 naloga kroz lifecycle; 24 aktivna plaćena
   naloga koriste novi nemapirani price, 60 su zdravi, 6 istekli, 4 policy denial,
   3 identity unknown, 3 stale/unavailable evidence.
2. Mock Adapty consumer za novi price ne aktivira pravo. Lumen za kupca vraća 403.
3. Reconcile iz nezavisnog provider registra nalazi 24 kandidata i proverava
   individualne dokaze: 100 scope / 94 evaluable / 24 affected / 6 inconclusive.
4. UI prikazuje plaćenu kupovinu, odsutno Adapty pravo, odsutan katalog mapping
   i odbijen klijentski gate, sa povezanim dokazima.
5. Operator odobrava katalog preduslov i validaciju tačno 24 kupovine. Mock
   validacija koristi dokumentovane preduslove, pa kreira odgovarajuće stanje.
6. Svež Adapty readback potvrđuje 24 aktivacije. Klijentski resync i gate potvrđuju
   samo 23: jednom nalogu ostaje stvarno zastareo cache.
7. Novo odobrenje za preostali cache resync završava 24/24. Ponovno izvršenje
   prethodnog plana ne uvodi nove transakcije ili licence. Isti Lumen kupac dobija 200.

24 aktivacije i 23 dostupna gate-a moraju biti odvojeni brojači. Ne koristiti
„recovered revenue“: novac je već naplaćen. Meriti obnovljene aktivacije/pristupe,
vreme do oporavka, manual korake, false positives i pokrivenost dokazima.

## Izmene postojećeg projekta

| Paket | Konkretan posao | Uslov prihvatanja |
| --- | --- | --- |
| Modeli i simulatori | Dodati nezavisan provider ledger, mock Adapty catalog/profile/validation i provider capability map | Kvar se proizvodi kroz lifecycle; detector ne čita oracle/fault label |
| Engine | Nadograditi paid_access orchestration sa upstream pravilima i koracima plana | Konfiguracija/identitet/period provereni pre writes; unknown ostaje unknown |
| Adapter i collector | Zadržati collector_sdk/lumen_app; dodati evidence reference, provider readback i step receipts | Client signal nije dovoljan payment dokaz; tajne van eksportovanih podataka |
| UI | access-app dobija tri kolone dokaza, capability/status i odvojene brojače | Neaktivirana kupovina može se videti i pre nego što postoji Adapty događaj |
| Verifikacija | Zadržati postojećih 75 testova i dodati nove acceptance scenarije | Novi 100-account replay plus svi negativni testovi prolaze |

Obavezni novi negativni slučajevi: plaćeno ali pogrešan korisnik; ručni grant bez
naplate; refund/revocation pre apply; pending/zero-value invoice; trial/grace;
dupli i van redosleda događaji; validacija timeout posle uspešnog upisa; self-heal
pre apply; zastareo katalog; source 429/outage; Apple/Google restore čeka uređaj;
onemogućen gate probe; izostala kupovina iz oba Adapty i client registra ali
prisutna u provider backfill-u. Alternativni seed menja IDs/cohort. Za negativne
kontrole očekivati 0 nedozvoljenih writes, a ne veštački isti broj oporavljenih.

Prioritet: prvo kompletan upstream Stripe scenario i postojeći Lumen završetak;
zatim mali Paddle/custom tokovi i Apple/Google dijagnostičke kontrole kroz isti
engine. Sve to su mock adapteri. Live provider integracija i mobilni SDK portovi
dolaze tek posle sandbox validacije ugovora i razgovora sa Adapty timom.

## Potvrda vrednosti sa Adapty timom

Tri konkretna pitanja: koje paid-but-not-activated incidente podrška rešava,
koji postojeći interni alati ih već detektuju i koje recovery operacije smeju da
se pokrenu grupno uz odobrenje? Tražiti anonimizovane obrasce slučajeva, ne stvarne
payment podatke korisnika. Pilot predlog: prvo read-only poređenje potvrđenih
slučajeva sa zaključkom podrške, zatim sandbox approved recovery. Kriterijumi:
tačnost detekcije, nijedna nedozvoljena dodela i merljivo manje manual koraka.
Učestalost problema, komercijalna tražnja i partnerstvo još nisu potvrđeni.
