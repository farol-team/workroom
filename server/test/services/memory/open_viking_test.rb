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

  # The sidecar is a dot-file because the store's own indexing skips dot-names;
  # a visible meta.json would be summarized, embedded, and surfaced in search.
  # That skip is a single `if` upstream, so a live store pins it (#213).
  test "the lineage sidecar stays out of what the room lists and finds" do
    skip "needs a live store" if ENV["OPENVIKING_URL"].blank?
    entry = @store.write(@channel, title: "Reporting cadence", detail: "Monthly rollups.")
    @store.annotate(entry.uri, seq: 1, entry_hash: "ab" * 32, action: "written")

    refute @store.all(@channel).any? { |e| e.uri.split("/").last.start_with?(".") },
           "the sidecar is bookkeeping, not something the room said"
    # `count` is the listing's own number: one entry was written, and a store
    # that counts the sidecar among what the room knows inflates it.
    assert_equal 1, @store.count(@channel), "the sidecar is not part of the listing either"
    found = eventually { @store.search(@channel, "reporting cadence") }
    refute found.any? { |e| e.uri.split("/").last.start_with?(".") },
           "a sidecar answering a search is the entry's provenance pretending to be the entry"
  end
end

# Where an entry goes when it is superseded is a fact about the layout, and a
# layout that does not explain a uri cannot be guessed at. No live store: the
# derivation happens before anything is read, which is the whole point — a
# store that is asked to move an entry nowhere must not be asked at all.
class Memory::OpenVikingArchiveTest < ActiveSupport::TestCase
  def store
    Memory::OpenViking.new(base_url: "http://127.0.0.1:1", api_key: "unused")
  end

  test "an entry the channels root does not explain has no archive to move to" do
    assert_raises(Memory::OpenViking::Error) { store.supersede("viking://user/alice/note.md") }
  end

  test "a uri that is the channels root and nothing more is not an entry" do
    assert_raises(Memory::OpenViking::Error) { store.supersede("viking://resources/channels/") }
  end
end

# A store that cannot be reached. No live instance: the point is a store that is
# not there, and a name in `.invalid` is guaranteed by RFC 2606 never to be.
#
# Connection refused and both timeouts already arrived as the adapter's own
# error. A name that does not resolve did not — `Socket::ResolutionError` is a
# `SocketError`, which is not a `SystemCallError` — so it travelled past every
# `rescue Error` in the adapter and out of the controller as a 500 (#146).
class Memory::OpenVikingUnreachableTest < ActiveSupport::TestCase
  def store
    Memory::OpenViking.new(base_url: "http://does-not-resolve.invalid", api_key: "unused")
  end

  setup { @channel = channel(name: "Meetings") }

  # Asserted on `write`, which is the one path that does not swallow: `read`,
  # `list`, `mkdir` and `tag` each rescue Error by design.
  test "a name that does not resolve arrives as the adapter's own error" do
    assert_raises(Memory::OpenViking::Error) do
      store.write(@channel, title: "Reporting cadence", detail: "Monthly.")
    end
  end

  # The half that matters more. Rescuing alone would make an unreachable store
  # indistinguishable from a room that has learned nothing — which is #99, and
  # reads as the product being empty rather than as something being down. The
  # listing paths swallow by design, so the fact travels beside what they
  # return rather than in it.
  test "a store answers for its availability once it has failed to answer" do
    unreachable = store
    assert unreachable.available?, "a store nobody has asked about is taken at its word"

    assert_nil unreachable.context_for(@channel)
    refute unreachable.available?, "which is what tells that nil from a room that knows nothing"
  end
end

# A store that answers, badly. Reached, so nothing above the seam would learn
# anything from the transport — and just as empty to the room, which is the
# failure #146 exists to close and not only the one it was filed for.
class Memory::OpenVikingAnsweringBadlyTest < ActiveSupport::TestCase
  setup { @channel = channel(name: "Meetings") }

  # 404 and 409 are the store speaking, not failing: `read` follows a uri that
  # is gone, `mkdir` finds the directory already there. Reading those as down
  # would take every fresh room with them.
  test "an answer the store itself gave leaves it available" do
    answering(404) do |store|
      assert_nil store.context_for(@channel)
      assert store.available?
    end
  end

  test "a broken store and a key that reaches nothing are both unavailable" do
    [ 500, 502, 401, 403 ].each do |code|
      answering(code) do |store|
        assert_nil store.context_for(@channel)
        refute store.available?, "#{code} lists nothing, and nothing listed reads as an empty room"
      end
    end
  end

  # One connection, answered with a status and a well-formed empty body: `all`
  # asks for the listing first and reads nothing when it does not arrive.
  def answering(code)
    server = TCPServer.new("127.0.0.1", 0)
    thread = Thread.new do
      while (socket = server.accept)
        begin
          socket.readpartial(4096)
          socket.write("HTTP/1.1 #{code} Whatever\r\nContent-Type: application/json\r\n" \
                       "Content-Length: 2\r\nConnection: close\r\n\r\n{}")
        rescue IOError, SystemCallError
          nil # the client hung up first; the test is not about this socket
        ensure
          socket.close
        end
      end
    end

    yield Memory::OpenViking.new(base_url: "http://127.0.0.1:#{server.addr[1]}", api_key: "unused")
  ensure
    thread&.kill
    server&.close
  end
end

# Lineage is a verb of the seam, not a feature of one store: every write the
# server witnessed may be annotated with the journal record of it, and a store
# with no lineage index answers by doing nothing. `Memory::Local` inherits
# that answer unchanged (#213).
class Memory::StoreAnnotateTest < ActiveSupport::TestCase
  test "annotate is part of the seam, with a default of nothing done" do
    store = Memory::Store.new

    assert_nil store.annotate("viking://resources/channels/meetings/cadence.md",
                              seq: 1, entry_hash: "ab" * 32, action: "remember")
  end
end

# The sidecar protocol against a store that answers and remembers what it was
# asked. No live instance: the subject here is what the adapter sends, so the
# requests are kept and the answers are the minimum the adapter is built on —
# a read finds only the uris the test said exist, which is what `write` relies
# on to keep a key's first name.
class Memory::OpenVikingSidecarTest < ActiveSupport::TestCase
  setup { @channel = channel(name: "Meetings") }

  test "annotate writes the journal lineage beside the entry, as a dot-file" do
    uri = "viking://resources/channels/meetings/cadence.md"

    requests = recording do |store|
      store.annotate(uri, seq: 3, entry_hash: "ab" * 32, action: "remember",
                     uri: uri, trust: "agent", author_id: 7, run_id: 11,
                     recorded_at: Time.utc(2026, 8, 2, 12).iso8601)
    end

    writes = requests.select { |r| r[:path] == "/api/v1/content/write" }
    assert_equal 1, writes.length, "annotate writes the sidecar and nothing else"
    # A visible meta.json would be summarized, embedded and surfaced by search;
    # a dot-name next to the entry is skipped at every stage of the store's own
    # indexing — the premise of #213.
    assert_equal "viking://resources/channels/meetings/.cadence.meta.json", writes.first[:body]["uri"]
    assert_equal "create", writes.first[:body]["mode"]

    meta = JSON.parse(writes.first[:body]["content"])
    assert_equal 3, meta["seq"]
    assert_equal "ab" * 32, meta["entry_hash"]
    assert_equal "remember", meta["action"]
    assert_equal uri, meta["uri"]
    assert_equal "agent", meta["trust"]
    assert_equal 7, meta["author_id"]
    assert_equal 11, meta["run_id"]
    assert meta["recorded_at"].present?, "the journal moment, not the store's"
  end

  test "superseding moves the sidecar into the archive with the entry" do
    stale = "viking://resources/channels/meetings/cadence.md"

    requests = recording(existing: [ stale ]) { |store| store.supersede(stale) }

    moves = requests.select { |r| r[:path] == "/api/v1/fs/mv" }
                    .map { |r| [ r[:body]["from_uri"], r[:body]["to_uri"] ] }
    assert_equal 2, moves.length, "the entry and its lineage travel together (Article P6)"
    assert_includes moves, [ stale, "viking://resources/superseded/channels/meetings/cadence.md" ]
    assert_includes moves, [ "viking://resources/channels/meetings/.cadence.meta.json",
                             "viking://resources/superseded/channels/meetings/.cadence.meta.json" ]
  end

  test "a missing sidecar does not stop a supersession" do
    stale = "viking://resources/channels/meetings/cadence.md"
    moved = nil

    requests = recording(existing: [ stale ], fail_sidecar_mv: true) do |store|
      moved = store.supersede(stale)
    end

    assert_equal stale, moved.uri, "the sidecar is an index, not the record"
    attempted = requests.select { |r| r[:path] == "/api/v1/fs/mv" }.map { |r| r[:body]["from_uri"] }
    assert_includes attempted, "viking://resources/channels/meetings/.cadence.meta.json",
                    "the move was tried, and its failure tolerated like a tag that did not stick"
  end

  # The journal is the source of truth and the sidecar only its index: a store
  # that refuses the sidecar must not refuse the fact. Same rescue idiom as
  # `tag` — an index that did not stick is not a failed write.
  test "a sidecar the store refused to write is not an error" do
    uri = "viking://resources/channels/meetings/cadence.md"

    requests = recording(fail_sidecar_write: true) do |store|
      assert_nothing_raised do
        store.annotate(uri, seq: 3, entry_hash: "ab" * 32, action: "remember")
      end
    end

    attempted = requests.select { |r| r[:path] == "/api/v1/content/write" }
    assert_equal 1, attempted.length, "the write was tried, and its refusal swallowed"
    assert_equal "viking://resources/channels/meetings/.cadence.meta.json", attempted.first[:body]["uri"]
  end

  private

  def recording(existing: [], fail_sidecar_mv: false, fail_sidecar_write: false)
    requests = []
    server = TCPServer.new("127.0.0.1", 0)
    thread = Thread.new do
      while (socket = server.accept)
        begin
          answer(socket, requests, existing, fail_sidecar_mv, fail_sidecar_write)
        rescue IOError, SystemCallError
          nil # the client hung up first; the test is not about this socket
        ensure
          socket.close
        end
      end
    end

    yield Memory::OpenViking.new(base_url: "http://127.0.0.1:#{server.addr[1]}", api_key: "unused")
    requests
  ensure
    thread&.kill
    server&.close
  end

  def answer(socket, requests, existing, fail_sidecar_mv, fail_sidecar_write)
    request_line = socket.gets
    return unless request_line

    method, target = request_line.split(" ")
    headers = {}
    while (line = socket.gets) && line != "\r\n"
      key, value = line.chomp.split(": ", 2)
      headers[key.downcase] = value
    end
    body = socket.read(headers["content-length"].to_i) if headers["content-length"]

    uri = URI.parse(target)
    params = uri.query ? URI.decode_www_form(uri.query).to_h : {}
    json = body.to_s.empty? ? {} : JSON.parse(body)
    requests << { method:, path: uri.path, params:, body: json }

    payload = "{}"
    if uri.path == "/api/v1/content/read" && existing.include?(params["uri"])
      payload = { result: "---\ntitle: Cadence\n---\n\n# Cadence\n\nWeekly.\n" }.to_json
    elsif uri.path == "/api/v1/fs/mv" && fail_sidecar_mv && json["from_uri"].to_s.end_with?(".meta.json")
      payload = { status: "error", error: { message: "no such file" } }.to_json
    elsif uri.path == "/api/v1/content/write" && fail_sidecar_write && json["uri"].to_s.end_with?(".meta.json")
      payload = { status: "error", error: { message: "read-only filesystem" } }.to_json
    end

    socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" \
                 "Content-Length: #{payload.bytesize}\r\nConnection: close\r\n\r\n#{payload}")
  end
end
