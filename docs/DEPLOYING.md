# Deploying the server

One machine, one container, a managed PostgreSQL that already exists, and Kamal
between them. `bin/kamal deploy` from a laptop or from CI.

## What has to exist first

| | |
|---|---|
| a virtual machine | 2 vCPU / 2 GB is enough for one team; Kamal installs Docker on it |
| a container registry | the image is pushed there and pulled by the machine |
| a database | **already exists** — see below |
| a bucket | S3-compatible, for artifacts |
| a domain | pointed at the machine; the proxy gets a certificate for it |

## The database is shared, and that shapes everything

The managed cluster it runs on hosts other applications. WorkRoom gets **its own
databases and its own user**, and touches nothing else:

```
workroom_production           the room: channels, messages, memory, runs
workroom_production_cable     Solid Cable, and only that
```

The second one is not optional. `config/database.yml` declares it in production,
and a managed cluster will not create it for you — a deploy against a cluster
with only the first database starts, serves, and silently carries no live
updates at all.

Nothing in `config/deploy.yml` may create, migrate or destroy that cluster. It is
deliberately not an accessory: `kamal setup` must not be able to take down a
database three other applications are using.

## Secrets

Names live in `.kamal/secrets`; values live in the environment of whoever runs
the deploy. The registry password is an IAM token and expires, so it is fetched
rather than stored.

```bash
export KAMAL_REGISTRY_USERNAME=iam
export KAMAL_REGISTRY_PASSWORD=$(yc iam create-token)

export SECRET_KEY_BASE=$(openssl rand -hex 64)
export DATABASE_URL="postgres://workroom:PASSWORD@HOST:6432"
export WORKROOM_ALLOWED_ORIGINS="https://workroom.example"
```

`WORKROOM_ALLOWED_ORIGINS` is not a convenience. A bearer token plus an open
origin policy is any page on the internet acting as the person holding it, and
the application refuses to boot in production without it.

The same is true of the context store:

```bash
export OPENVIKING_URL="http://workroom-context:8000"
export OPENVIKING_API_KEY="..."
```

Without it, what every room knows would be kept in PostgreSQL — which works,
and retrieves by substring rather than by meaning. That is a legitimate choice
and an illegitimate accident, and a server cannot tell them apart, so it
refuses the accident. If PostgreSQL is genuinely what you want in production,
say so:

```bash
export WORKROOM_MEMORY_IN_POSTGRES=true
```

Exactly `true`. `1` and `yes` are what people type when they are guessing, and
this variable exists so the choice is stated rather than stumbled into.

## What a first deploy does, and does not

It creates both databases, runs migrations, and **refuses to seed**. The seed
creates two people with fixed tokens (`dev-alice`, `dev-bob`) so a fresh install
has something to look at — in production those are a working key to a working
server, so `db/seeds.rb` stops before it starts. `db:prepare` runs on every boot
and seeds a database it just created, so this is a guard rather than a
convention.

A workspace with no `OIDC_ISSUER` has **no way to sign in**, and says so: the
client asks `/api/auth/methods`, gets `development: false, provider: false`, and
shows a sentence instead of a form that cannot work. That is the correct state
for a server that is up before its identity provider is configured.

## Verified, and where

The production image was built and booted against a real PostgreSQL before any
of this reached a cloud. Four things were wrong and none of them would have
appeared in development:

- the image had **never been built** — the Dockerfile does not copy
  `.ruby-version`, which the Gemfile reads, so `bundle install` died on the
  first layer
- artifacts were configured to the container's own disk, which a deploy replaces
- `assume_ssl` and `force_ssl` were commented out, so Rails would have built
  `http://` urls behind a proxy terminating TLS
- the first boot **seeded production**

## Releasing

```bash
cd server && bin/kamal deploy
```

Kamal builds the image, pushes it, pulls it on the machine, boots the new
container, waits for `/up`, and moves traffic across. The old container stays
until the new one answers, so a failed boot is a deploy that did not happen
rather than an outage.
