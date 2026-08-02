require "test_helper"

# What the memory panel costs to answer, counted in queries. The sibling of
# test/controllers/api/memory_controller_test.rb, which says what it answers.
#
# Provenance is the expensive part: every entry leads back to a run, the run to
# a session, the session to the person whose agent it was (Article P4). Read one
# entry at a time that is three queries per line of a listing (#177).
class Api::V1::MemoryControllerLoadTest < ActionDispatch::IntegrationTest
  # A ceiling, not a budget — see the same note in channels_controller_test.rb.
  # The equality below forbids a cost that grows with the room; this forbids
  # paying it back as a fixed cost instead.
  LISTING_CEILING = 14

  setup { @alice = user(name: "Alice") }

  test "listing what a room knows does not cost a query per entry" do
    little = room_that_learned(1)
    lot    = room_that_learned(6)

    little_cost = listing(little).size
    lot_cost    = listing(lot).size

    assert_equal little_cost, lot_cost,
                 "provenance is loaded with the listing, not walked one entry at a time"
    assert_operator lot_cost, :<=, LISTING_CEILING,
                    "and what the panel costs is a handful of queries, whatever the room has learned"
  end

  test "a listing loaded in one go still says who recorded each entry" do
    room = room_that_learned(2)

    get api_v1_channel_memory_path(room.slug), headers: auth(@alice)

    assert_response :success
    # Entry by entry, against what was written — not two lists checked for
    # holding the same names between them. A chain fetched in one go and keyed
    # back to the wrong entry is precisely what this file's other half invites,
    # and a listing where every agent belongs to somebody else reads as correct
    # to any assertion that sorts before it compares.
    #
    # The whole author is compared, so a person who was not a turn keeps no run
    # and an entry that was one keeps the run it came from (Article P4).
    assert_equal @recorded, response.parsed_body.to_h { |e| [ e["title"], e["author"] ] },
                 "an entry that leads back to the wrong person leads nowhere"
  end

  private

  # What a colleague's agent concluded and what the colleague stated themselves,
  # each round by a different person — provenance resolves differently for the
  # two, and no two entries share the row at the end of the chain, so a listing
  # that walks it cannot be rescued by the request's query cache.
  #
  # `@recorded` is what was written, by title: the listing is compared against
  # it rather than against itself.
  def room_that_learned(rounds)
    room = channel(slug: "room-#{SecureRandom.hex(3)}")
    @recorded = {}
    rounds.times do |i|
      speaker = user(name: "Colleague #{i}")
      run = agent_run(user: speaker, channel: room)
      Memory::Store.current.write(room, title: "Inferred #{i}", detail: "What the agent concluded, #{i}.",
                                  trust: "agent", author: speaker, source: run)
      Memory::Store.current.write(room, title: "Stated #{i}", detail: "What the person said, #{i}.",
                                  trust: "human", author: speaker)
      @recorded["Inferred #{i}"] = { "kind" => "agent", "name" => speaker.name,
                                     "agent_kind" => "opencode", "run_id" => run.id }
      @recorded["Stated #{i}"] = { "kind" => "human", "name" => speaker.name }
    end
    room
  end

  def listing(room)
    get api_v1_channel_memory_path(room.slug), headers: auth(@alice)
    queries_while { get api_v1_channel_memory_path(room.slug), headers: auth(@alice) }
  end

  # Every statement the request actually sent. Schema reads and the transaction
  # it runs in are not what the room pays for, and a query answered from the
  # request's own cache was never sent.
  def queries_while
    sent = []
    counter = ->(_name, _start, _finish, _id, payload) do
      sent << payload[:sql] unless payload[:cached] || %w[SCHEMA TRANSACTION].include?(payload[:name])
    end
    ActiveSupport::Notifications.subscribed(counter, "sql.active_record") { yield }
    sent
  end
end
