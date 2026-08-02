class ChannelsNameTheirRepository < ActiveRecord::Migration[8.1]
  # Which repository the room's work lives in. This is a fact of the room, not
  # of anybody's machine: a colleague joining the channel should land in the
  # same checkout everybody else works against (#203).
  #
  # Null-true because most rooms have no repository — a `meetings` channel is
  # not a codebase — and a NOT NULL with a default would invent an address for
  # rooms that never had one, which is worse than saying none. Clearing the
  # setting writes NULL back, so "no repository" and "never asked" stay the
  # same value, the way they are the same fact.
  def change
    add_column :channels, :repository_url, :string, null: true
  end
end
