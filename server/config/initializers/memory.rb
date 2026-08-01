# Which store holds what the rooms know.
#
# PostgreSQL until a context database is configured, and the swap is one
# environment variable because nothing outside `Memory::Store` knows the
# difference (Article S1).
#
# The choice lives in Memory::Selection rather than here, because in production
# the interesting case is the one nobody sees — a server deployed without a
# context store, quietly keeping every room's knowledge in PostgreSQL — and an
# initializer cannot be tested without booting a second application.
# Asked at boot rather than installed at boot: the store is resolved per
# request now, because one process serves every workspace (#140). What this
# keeps is the refusal — a production server with no context store anywhere
# fails to start rather than quietly keeping every room's knowledge in
# PostgreSQL (#112).
Rails.application.config.to_prepare do
  Memory::Selection.new.store_class
end
