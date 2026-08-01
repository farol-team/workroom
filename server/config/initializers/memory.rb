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
Rails.application.config.to_prepare do
  Memory::Store.current = Memory::Selection.new.store
end
