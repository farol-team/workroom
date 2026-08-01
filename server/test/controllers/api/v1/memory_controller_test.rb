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
    authors = response.parsed_body.map { |e| e["author"] }
    # Sorted: a listing answers most trusted and most recent first, which is the
    # store's business and not this file's — what is asserted here is that every
    # line says who, and that neither kind of entry lost anything to the other.
    assert_equal %w[agent agent human human], authors.map { |a| a["kind"] }.sort
    assert_equal [ "Colleague 0", "Colleague 0", "Colleague 1", "Colleague 1" ],
                 authors.map { |a| a["name"] }.sort

    agents = authors.select { |a| a["kind"] == "agent" }
    assert_equal %w[opencode opencode], agents.map { |a| a["agent_kind"] }
    assert agents.all? { |a| a["run_id"].present? },
           "an entry a colleague cannot follow back is a defect (Article P4)"
    assert authors.select { |a| a["kind"] == "human" }.none? { |a| a.key?("run_id") },
           "a person was not a turn, and having no run is not a missing record"
  end

  private

  # What a colleague's agent concluded and what the colleague stated themselves,
  # each round by a different person — provenance resolves differently for the
  # two, and no two entries share the row at the end of the chain, so a listing
  # that walks it cannot be rescued by the request's query cache.
  def room_that_learned(rounds)
    room = channel(slug: "room-#{SecureRandom.hex(3)}")
    rounds.times do |i|
      speaker = user(name: "Colleague #{i}")
      Memory::Store.current.write(room, title: "Inferred #{i}", detail: "What the agent concluded, #{i}.",
                                  trust: "agent", author: speaker,
                                  source: agent_run(user: speaker, channel: room))
      Memory::Store.current.write(room, title: "Stated #{i}", detail: "What the person said, #{i}.",
                                  trust: "human", author: speaker)
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
