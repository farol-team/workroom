require "test_helper"
require_relative "store_contract"

# The same contract Memory::Local satisfies, against a real context database.
#
# Article V says the real store, not a mock — a mock of OpenViking would assert
# what we imagine it does, and the whole point of this suite is that we do not.
# Without a live instance the suite refuses to run rather than passing quietly.
class Memory::OpenVikingTest < ActiveSupport::TestCase
  include Memory::StoreContract

  def build_store
    Memory::OpenViking.new(base_url: ENV["OPENVIKING_URL"], api_key: ENV["OPENVIKING_API_KEY"])
  end

  def setup
    skip "set OPENVIKING_URL and OPENVIKING_API_KEY to run the adapter against a live store" \
      if ENV["OPENVIKING_URL"].blank?
    super
    clear!(@channel)
    clear!(@other)
  end

  # Indexing is asynchronous by design — see the adapter's write. Retrieval
  # tests wait for it rather than pretending it is instant.
  def eventually(seconds: 60)
    deadline = Time.current + seconds
    loop do
      result = yield
      return result if result.present?
      raise Minitest::Assertion, "nothing was retrievable within #{seconds}s" if Time.current > deadline
      sleep 2
    end
  end

  # Entries are files, and files outlive a database transaction.
  def clear!(channel)
    @store.all(channel, limit: 200).each { |e| @store.supersede(e.uri) }
  end

  test "a question finds the entry that answers it, without sharing a word with it" do
    skip "needs a live store" if ENV["OPENVIKING_URL"].blank?
    @store.write(@channel, title: "Reporting cadence",
                 detail: "Acme asked for monthly rollups. Weekly created noise and nobody read it.",
                 trust: "human")

    found = eventually { @store.search(@channel, "how often does the client want to hear from us?") }

    assert_equal [ "Reporting cadence" ], found.map(&:title),
                 "retrieval is by meaning; ILIKE would find nothing here"
  end

  test "the abstract is computed by the store, not truncated by us" do
    skip "needs a live store" if ENV["OPENVIKING_URL"].blank?
    detail = "Acme's operations lead asked for monthly rollups. Weekly reporting created " \
             "noise for their team and nobody read it. Agreed on the first Tuesday of each month."
    @store.write(@channel, title: "Reporting cadence", detail: detail, trust: "human")

    found = eventually { @store.search(@channel, "reporting cadence") }.first

    refute_nil found
    refute_equal detail.truncate(400), found.abstract
    assert found.abstract.length > 40, "an abstract worth the round trip"
  end

  test "trust and authorship survive the round trip" do
    skip "needs a live store" if ENV["OPENVIKING_URL"].blank?
    alice = user(name: "Alice")
    @store.write(@channel, title: "Stated", detail: "By a person.", trust: "human", author: alice)
    @store.write(@channel, title: "Inferred", detail: "By an agent.", trust: "agent")

    by_title = @store.all(@channel).index_by(&:title)

    assert_equal "human", by_title["Stated"].trust
    assert_equal "Alice", by_title["Stated"].author_name, "provenance is not decoration (Article P4)"
    assert_equal "agent", by_title["Inferred"].trust
  end

  test "superseding moves an entry out of the room, and destroys nothing" do
    skip "needs a live store" if ENV["OPENVIKING_URL"].blank?
    entry = @store.write(@channel, title: "Weekly", detail: "Weekly rollups.", key: "cadence")
    @store.supersede(entry.uri)

    assert_empty @store.all(@channel).map(&:title)
    archived = entry.uri.sub("resources/channels/", "resources/superseded/")
    assert @store.send(:read, archived), "the record moved rather than vanished (Article P6)"
  end
end
