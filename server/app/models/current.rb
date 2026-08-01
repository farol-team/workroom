class Current < ActiveSupport::CurrentAttributes
  # Which room this request belongs to. Set where the token is resolved, which
  # #134 made a single lookup — so a request that has authenticated has already
  # named its workspace, and one that has not has named nothing.
  #
  # Nothing reads this to filter yet. It is read to *stamp*: a record created
  # with no workspace in scope is a bug rather than a default, and once
  # row-level security lands it is a row nobody can read back.
  attribute :workspace
end
