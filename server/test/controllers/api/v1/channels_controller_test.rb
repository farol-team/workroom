require "test_helper"

# What a room costs to answer for, counted in queries.
#
# A sibling of test/controllers/api/channels_controller_test.rb rather than a
# second half of it: that file says what the endpoints answer, this one says
# what answering costs, and the two go red for different reasons. The count of
# queries is the only figure here that does not move with the machine the suite
# runs on — and an N+1 is precisely a figure that grows with the room (#177).
#
# Nothing here asserts the SQL. A grouped count over messages and a left join
# from channels are both correct answers, and a spec that names one of them
# would fail the other for being spelled differently.
class Api::V1::ChannelsControllerLoadTest < ActionDispatch::IntegrationTest
  # Ceilings, not budgets. The equality assertions below say the cost does not
  # grow with the room; these say it was not traded for a fixed cost nobody
  # notices — a fix that removes one query per message and adds ten per request
  # satisfies every equality in this file and none of these.
  SIDEBAR_CEILING = 10
  ROOM_CEILING = 18

  setup { @alice = user(name: "Alice") }

  test "the sidebar costs the same whether the workspace has three rooms or six" do
    3.times { |i| room_where_somebody_spoke("early-#{i}") }
    refreshing # the first refresh of a session, which nobody pays twice

    three = refreshing.size

    3.times { |i| room_where_somebody_spoke("later-#{i}") }

    assert_equal three, refreshing.size,
                 "a refresh costs what the sidebar costs, not what the workspace has grown to (#99)"
    assert_operator three, :<=, SIDEBAR_CEILING,
                    "the sidebar is the cheapest thing the client asks for"
  end

  test "the sidebar counts every room, including the one nobody has spoken in" do
    channel(slug: "silent", name: "A Silent")
    3.times { |i| room_where_somebody_spoke("busy-#{i}") }

    get api_v1_channels_path, headers: auth(@alice)

    assert_response :success
    assert_equal [ 0, 2, 2, 2 ], response.parsed_body.map { |c| c["message_count"] },
                 "a room nobody has spoken in has said nothing, which is a number and not an absence"
  end

  test "opening a room does not cost a query per message in it" do
    quiet = room_where_people_and_agents_spoke(1)
    busy  = room_where_people_and_agents_spoke(6)

    quiet_cost = opening(quiet).size
    busy_cost  = opening(busy).size

    assert_equal quiet_cost, busy_cost,
                 "what a room costs to open is a property of the room, not of how much was said in it"
    assert_operator busy_cost, :<=, ROOM_CEILING,
                    "and the fixed part of it is a handful of queries, not a new one for each old one"
  end

  test "a room opened in one go still says who spoke, person and agent alike" do
    room = room_where_people_and_agents_spoke(2)

    get api_v1_channel_path(room.slug), headers: auth(@alice)

    assert_response :success
    # An opened room carries the same count the sidebar does, off the same
    # serializer — which is the one the counts hash is about to be threaded
    # through. A count that reaches the listing and not the room it opens is a
    # number that went missing where nobody was looking (#177).
    assert_equal 4, response.parsed_body["message_count"],
                 "what a room says it holds does not depend on which endpoint was asked"
    assert_equal room.slug, response.parsed_body["slug"]

    authors = response.parsed_body["messages"].map { |m| m["author"] }
    assert_equal %w[user agent user agent], authors.map { |a| a["kind"] },
                 "a message written by an agent is attributed to the run, one written by a person to them"
    assert_equal [ "Colleague 0" ] * 2 + [ "Colleague 1" ] * 2, authors.map { |a| a["name"] },
                 "an agent's answer still carries the name of whoever's agent it is"
    assert_equal %w[opencode opencode], authors.filter_map { |a| a["agent_kind"] }
    assert authors.select { |a| a["kind"] == "user" }.all? { |a| a["email"].present? },
           "a person in the transcript is the same person the client already knew"
  end

  private

  def room_where_somebody_spoke(slug)
    room = channel(slug: slug, name: slug.titleize)
    2.times { |n| room.messages.create!(author: @alice, body: "said #{n}") }
    room
  end

  # A person asks and an agent answers, each round by a different colleague — so
  # a serializer reading authors one at a time cannot be rescued by the request's
  # query cache, which would make eight reads of one row look like a single
  # query and hide exactly what this file measures.
  def room_where_people_and_agents_spoke(rounds)
    room = channel(slug: "room-#{SecureRandom.hex(3)}", name: "Room #{SecureRandom.hex(3)}")
    rounds.times do |i|
      speaker = user(name: "Colleague #{i}")
      room.messages.create!(author: speaker, body: "asked #{i}")
      room.messages.create!(author: agent_run(user: speaker, channel: room), body: "answered #{i}")
    end
    room
  end

  # The first visit to a room is also where the membership is made; the second is
  # what a person pays every time after that, which is the one worth measuring.
  def opening(room)
    get api_v1_channel_path(room.slug), headers: auth(@alice)
    queries_while { get api_v1_channel_path(room.slug), headers: auth(@alice) }
  end

  def refreshing
    queries_while { get api_v1_channels_path, headers: auth(@alice) }
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
