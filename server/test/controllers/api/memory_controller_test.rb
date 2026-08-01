require "test_helper"

class Api::V1::MemoryControllerTest < ActionDispatch::IntegrationTest
  setup do
    @channel = channel
    @alice = user(name: "Alice")
    @json = { "Content-Type" => "application/json" }
  end

  # A store that answers, so following the seam is observable rather than assumed.
  class Elsewhere < Memory::Store
    Entry = Struct.new(:uri, :title, :abstract, :overview, :detail, :trust, :created_at,
                       keyword_init: true) do
      def slice(*keys) = keys.index_with { |k| public_send(k) }
    end

    def all(_channel, limit: 200)
      [ Entry.new(uri: "viking://elsewhere/1", title: "Held somewhere else",
                  abstract: "a", overview: "o", detail: "d", trust: "agent",
                  created_at: Time.current) ].first(limit)
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

  # A listing is a bare array, so a store that could not be reached hands back
  # the same empty list as a room that has learned nothing — the failure #99
  # cost once, arriving through a second door now that every transport error is
  # translated (#146). The list stays a list; the fact travels beside it.
  test "a listing from a store that cannot be reached says so" do
    with_store(Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid",
                                      api_key: "unused")) do
      get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)
    end

    assert_response :success
    assert_empty response.parsed_body
    assert_equal "unavailable", response.headers["X-Memory"],
                 "an empty list from a store that is away is not a room that knows nothing"
  end

  test "a listing from a store that answers says so too" do
    with_store(Elsewhere.new) do
      get api_v1_channel_memory_path(@channel.slug), headers: auth(@alice)
    end

    assert_equal "ok", response.headers["X-Memory"]
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

  private

  def with_store(store)
    previous = Memory::Store.current
    Memory::Store.current = store
    yield
  ensure
    Memory::Store.current = previous
  end
end
