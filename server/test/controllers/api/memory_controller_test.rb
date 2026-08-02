require "test_helper"

class Api::V1::MemoryControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  # A store that answers, so following the seam is observable rather than assumed.
  class Elsewhere < Memory::Store
    Entry = Struct.new(:uri, :title, :abstract, :overview, :detail, :trust, :author_name,
                       :created_at, keyword_init: true) do
      def slice(*keys) = keys.index_with { |k| public_send(k) }
      def source = nil
    end

    def all(_channel, limit: 200)
      [ Entry.new(uri: "viking://elsewhere/1", title: "Held somewhere else",
                  abstract: "a", overview: "o", detail: "d", trust: "agent",
                  author_name: "Alice", created_at: Time.current) ].first(limit)
    end

    def search(_channel, query, limit: 10)
      all(nil, limit: limit).select { |e| e.title.downcase.include?(query.downcase) }
    end
  end

  test "listing comes from the store, not from the table behind it" do
    # Article S1: swapping the store must not require touching a call site. A
    # listing that reads the local table returns nothing here, which looks
    # exactly like a room that knows nothing.
    @channel.memory_entries.create!(uri: "viking://local/1", title: "In the table",
                                    abstract: "a", overview: "o", detail: "d", trust: "human")

    with_store(Elsewhere.new) do
      get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)
    end

    assert_response :success
    assert_equal [ "Held somewhere else" ], response.parsed_body.map { |e| e["title"] }
  end

  test "searching comes from the store too" do
    with_store(Elsewhere.new) do
      get api_v1_channel_memory_path(@channel.slug), params: { q: "somewhere" }, headers: auth(@alice)
    end

    assert_equal [ "Held somewhere else" ], response.parsed_body.map { |e| e["title"] }
  end

  # The listing is a bare array with nowhere in it to say which of the two this
  # is, so for now it says the smaller thing: the room opens (#146). Telling an
  # empty list from a store that is away needs a wire change and a client that
  # reads it, which is the card filed after this one.
  test "a listing from a store that cannot be reached is a listing, not a 500" do
    with_store(Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid",
                                      api_key: "unused")) do
      get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)
    end

    assert_response :success
    assert_empty response.parsed_body
  end

  test "what a person records is what the room lists" do
    post api_v1_channel_memory_path(@channel.slug),
         params: { title: "Monthly rollups", detail: "First Tuesday." }.to_json,
         headers: auth(@alice).merge(@json)
    assert_response :created

    get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)
    assert_equal [ "Monthly rollups" ], response.parsed_body.map { |e| e["title"] }
    assert_equal "human", response.parsed_body.first["trust"]
  end

  test "the listing says whose agent recorded an entry" do
    run = agent_run(user: @alice, channel: @channel)
    run.update!(model: "ChatGPT 5.5")
    Memory::Store.current.write(@channel, title: "Pricing objection", detail: "Setup cost.",
                                trust: "agent", author: @alice, source: run)

    get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)

    author = response.parsed_body.first["author"]
    assert_equal "agent", author["kind"]
    assert_equal "Alice", author["name"]
    assert_equal "opencode", author["agent_kind"]
    assert_equal "ChatGPT 5.5", author["model"]
    assert_equal run.id, author["run_id"], "an entry a colleague cannot follow back is a defect (Article P4)"
  end

  test "what a person records is attributed to them and to no run" do
    post api_v1_channel_memory_path(@channel.slug),
         params: { title: "Monthly rollups", detail: "First Tuesday." }.to_json,
         headers: auth(@alice).merge(@json)

    assert_equal({ "kind" => "human", "name" => "Alice" }, response.parsed_body["author"],
                 "they were not a turn")
  end

  # However memory was written — by an agent through the rail or by a person
  # here — the room's journal is one entry longer. A record that only knows
  # about the agent's writes describes half a room.
  test "what a person records lengthens the room's journal" do
    assert_difference -> { @channel.channel_records.where(kind: "memory").count }, 1 do
      post api_v1_channel_memory_path(@channel.slug),
           params: { title: "Monthly rollups", detail: "First Tuesday." }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_equal 1, @channel.channel_records.count, "one write, one entry"

    entry = @channel.channel_records.order(:seq).last
    payload = JSON.parse(RecordStore::Objects.current.get(entry.entry_hash))["payload"]

    assert_equal "written", payload["action"]
    assert_equal response.parsed_body["uri"], payload["uri"]
    assert_equal "Monthly rollups", payload["title"]
    assert_equal "First Tuesday.", payload["detail"],
                 "the journal holds what the room learned, not only that it learned something"
    assert_equal "human", payload["trust"]
    assert_equal @alice.id, payload["author_id"], "an entry nobody can trace back is a defect (Article P4)"
  end

  test "a write the room refused is in no journal" do
    assert_no_difference -> { @channel.channel_records.count } do
      post api_v1_channel_memory_path(@channel.slug),
           params: { title: "Missing its detail" }.to_json,
           headers: auth(@alice).merge(@json)
    end

    assert_response :unprocessable_content
  end

  # The person wrote and the server witnessed it, so the store is told the
  # journal lineage of what it now holds — the same sidecar a write through
  # the rail carries (#213). The lineage the controller hands over is the
  # subject here; what the OpenViking adapter does with it is pinned in
  # open_viking_test.rb against the wire.
  test "what a person records is annotated with the journal lineage" do
    # The seam is swapped process-wide, like everywhere else in this file: a
    # request runs in its own execution context, and a store pinned to this
    # thread's `Current` never reaches the controller.
    store = Memory::Local.new
    annotations = []
    store.define_singleton_method(:annotate) { |uri, **lineage| annotations << [ uri, lineage ] }

    with_store(store) do
      post api_v1_channel_memory_path(@channel.slug),
           params: { title: "Monthly rollups", detail: "First Tuesday." }.to_json,
           headers: auth(@alice).merge(@json)
      assert_response :created
    end

    record = @channel.channel_records.order(:seq).last
    assert_equal 1, annotations.length, "a write the server witnessed is annotated"
    uri, lineage = annotations.first
    assert_equal response.parsed_body["uri"], uri
    assert_equal record.seq, lineage[:seq]
    assert_equal record.entry_hash, lineage[:entry_hash]
    assert_equal "written", lineage[:action]
  end

  private

  def with_store(store)
    previous = Memory::Store.current
    Memory::Store.current = store
    yield
  ensure
    Memory::Store.current = previous
  end
end
