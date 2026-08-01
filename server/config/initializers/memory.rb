# Which store holds what the rooms know.
#
# A context database when one is reachable, PostgreSQL when none is — a swap
# nothing outside `Memory::Store` can see (Article S1). The fallback is
# development's: it is why the suite needs no external service.
#
# The choice lives in Memory::Selection rather than here, because an
# initializer cannot be tested without booting a second application and this is
# a decision that used to fail silently in production — a server deployed
# without a context store, quietly keeping every room's knowledge in PostgreSQL.
#
# Asked at boot rather than installed at boot: the store is resolved per
# request now, because one process serves every workspace (#140). What this
# keeps is the refusal — a production server with no context store anywhere
# fails to start (#112).
Rails.application.config.to_prepare do
  Memory::Selection.new.store_class
end
