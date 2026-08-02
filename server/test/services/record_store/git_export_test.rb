require "test_helper"
require "tmpdir"
require "open3"

# The mirror spike #45 asked for. The journal already says what happened in a
# room and in which order; this replays it into a git repository, one commit per
# entry, so that `git log` over a folder answers "what does this room know, and
# when did it learn it" with no server, no database and no account in the way.
#
# The export invents nothing. Every file it writes and every name on every
# commit comes out of an envelope that was already in the object store.
class RecordStore::GitExportTest < ActiveSupport::TestCase
  STATE_FILE = ".workroom-export.json".freeze

  setup do
    skip "git is not installed" unless system("git", "--version", out: File::NULL, err: File::NULL)

    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @root = Dir.mktmpdir("wr-export")
    # A directory the operator has not created: `bin/rails record:export[meetings,
    # /tmp/wr-export]` is run against a path that does not exist yet.
    @path = File.join(@root, "meetings")
  end

  teardown do
    FileUtils.remove_entry(@root) if @root && File.exist?(@root)
  end

  # Three kinds, one of each, in the order a room produces them. The entries are
  # written through Append with the payloads the controllers and the rail
  # actually journal, because a spec that invents its own envelope shape proves
  # the export can read that shape and nothing else.
  test "a room's journal becomes one commit per entry, in the order the room recorded them" do
    said = message(body: "shall we meet Tuesday")
    remembered = memory(title: "Acme wants monthly reporting")
    delivered = artifact(name: "notes.txt")

    result = RecordStore::GitExport.call(@channel, path: @path)

    assert_path_exists File.join(@path, ".git")
    assert_equal 3, result.entries_exported
    assert_equal File.realpath(@path), File.realpath(result.repo_path)
    assert_equal 3, shas.length, "three things happened, so three commits"
    assert_equal shas.last, result.head_sha

    assert_equal [ [ "messages/#{month_of(said)}.jsonl" ],
                   [ "memory/acme-wants-monthly-reporting.md" ],
                   [ "artifacts/notes.txt" ] ],
                 shas.map { |sha| added_in(sha) - [ STATE_FILE ] },
                 "each commit is the entry it replays, oldest first"

    assert_equal [ remembered.seq, delivered.seq ], [ 2, 3 ], "the premise: the journal was in this order"
  end

  # The shape spike #45 printed: readable markdown, and every field a memory
  # entry carries surviving the trip. A mirror whose provenance is missing is a
  # folder of claims nobody can audit (Article P4).
  test "a memory write is markdown carrying who recorded it, when, and how far it is trusted" do
    entry = memory(title: "Acme wants monthly reporting", trust: "human", author: @alice)

    RecordStore::GitExport.call(@channel, path: @path)

    body = read("memory/acme-wants-monthly-reporting.md")
    front = front_matter(body)

    assert_equal "#{@channel.memory_uri}acme-wants-monthly-reporting", front["uri"]
    assert_equal "human", front["trust"]
    assert_equal "Alice", front["author"]
    assert_match(/Z\z/, front["recorded"], "in UTC, because when must not depend on who asks")
    assert_in_delta entry.created_at, Time.iso8601(front["recorded"]), 5
    assert_includes body, "Acme wants monthly reporting"
  end

  test "an artifact is the file itself, under the name it was given" do
    content = "minutes of the call #{SecureRandom.hex(8)}"

    artifact(name: "notes.txt", content:)
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal content, read("artifacts/notes.txt")
  end

  # Work product is not always text. Written through anything that treats it as
  # a String with an encoding it arrives corrupted, and nothing complains until
  # somebody opens it.
  test "a work product that is not text survives the export" do
    png = "\x89PNG\r\n\x1a\n\x00\x00\x00#{SecureRandom.hex(8)}".b

    artifact(name: "chart.png", content: png, content_type: "image/png")
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal png.bytes, File.binread(File.join(@path, "artifacts/chart.png")).bytes
  end

  test "messages are one json line each, in the file for the month they happened" do
    said = message(body: "shall we meet Tuesday")

    RecordStore::GitExport.call(@channel, path: @path)

    lines = read("messages/#{month_of(said)}.jsonl").lines
    assert_equal 1, lines.length

    line = JSON.parse(lines.first)
    assert_equal "shall we meet Tuesday", line["body"]
    assert_equal "Alice", line.dig("author", "name"), "who said it rides along"
  end

  # A month's file is appended to, not rewritten: the second export must not
  # lose the line the first one wrote.
  test "a later message joins the month's file rather than replacing it" do
    said = message(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)

    message(body: "Tuesday works")
    RecordStore::GitExport.call(@channel, path: @path)

    lines = read("messages/#{month_of(said)}.jsonl").lines
    assert_equal 2, lines.length
    assert_equal "shall we meet Tuesday", JSON.parse(lines.first)["body"]
    assert_equal "Tuesday works", JSON.parse(lines.last)["body"]
  end

  # The state file is what makes the second run a fast-forward rather than a
  # second history of the same events.
  test "the repository records how far the journal has been exported" do
    message(body: "shall we meet Tuesday")
    last = memory(title: "Acme wants monthly reporting")

    RecordStore::GitExport.call(@channel, path: @path)

    state = JSON.parse(read(STATE_FILE))
    assert_equal @channel.slug, state["channel"]
    assert_equal last.seq, state["last_seq"]
    assert_equal last.entry_hash, state["last_hash"]
  end

  # Running the task again after new work adds exactly the new entries. The
  # earlier commits keep their shas — history is added to, never rebuilt, or the
  # mirror is a different repository every time and nothing downstream of it
  # survives a refresh.
  test "a second export adds the new entries and leaves the earlier commits alone" do
    message(body: "shall we meet Tuesday")
    memory(title: "Acme wants monthly reporting")
    first = RecordStore::GitExport.call(@channel, path: @path)
    already = shas

    message(body: "Tuesday works")
    artifact(name: "agenda.md")
    second = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 2, first.entries_exported
    assert_equal 2, second.entries_exported
    assert_equal 4, shas.length
    assert_equal already, shas.first(2), "the mirror fast-forwards; it does not rewrite"
    assert_equal shas.last, second.head_sha
  end

  test "an export with nothing new to say writes no commit" do
    message(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)
    head = shas.last

    again = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 0, again.entries_exported
    assert_equal [ head ], shas
    assert_equal head, again.head_sha
  end

  # The one thing a mirror must never do quietly: fork from the journal it
  # claims to mirror. A state file that disagrees about where the chain was is
  # either tampering or a repository built from some other room's record, and
  # either way the export stops rather than appending onto it.
  test "a state file that disagrees with the journal stops the export" do
    message(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)
    head = shas.last

    tamper(last_hash: "0" * 64)
    message(body: "after the tampering")

    assert_raises RecordStore::GitExport::ChainMismatch do
      RecordStore::GitExport.call(@channel, path: @path)
    end

    assert_equal [ head ], shas, "an export that refuses writes nothing"
  end

  # Commit identity comes out of the entry, so `git log` answers who as well as
  # what. A person's own name and address, because that is what the record says.
  test "what a person recorded is committed under their name" do
    message(body: "shall we meet Tuesday")

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal "Alice <#{@alice.email}>", author_of(shas.last)
  end

  # An agent's write is not the person's own assertion and must not read as one
  # (Article P4). The turn it came from is in the address, so `git log --author`
  # finds a run's work.
  test "what an agent recorded names the run it came from" do
    run = agent_run(user: @alice, channel: @channel)

    memory(title: "Pricing objection", trust: "agent", author: @alice, run:)
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal "Alice's agent <agent+#{run.id}@workroom.local>", author_of(shas.last)
    assert_equal "agent", front_matter(read("memory/pricing-objection.md"))["trust"]
  end

  # Author is whoever the entry came from; committer is the export itself, for
  # every commit alike. The two questions are different, and flattening them
  # loses the one the mirror can actually vouch for.
  test "every commit is committed by the export, whoever authored it" do
    message(body: "shall we meet Tuesday")
    memory(title: "Pricing objection", trust: "agent", author: @alice,
           run: agent_run(user: @alice, channel: @channel))

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal [ "WorkRoom <record@workroom.local>" ] * 2, shas.map { |sha| committer_of(sha) }
  end

  # Article P3: a correction is a new entry that supersedes the old one, and the
  # old one stays readable. Exported as a deletion — or as an edit with no trace
  # — the mirror would be the memory model turned off.
  test "a supersession is a new version of the file, and the old one is still in the history" do
    memory(title: "Acme wants monthly reporting")
    supersede(title: "Acme wants monthly reporting", reason: "contradicted by a later call")

    RecordStore::GitExport.call(@channel, path: @path)

    file = "memory/acme-wants-monthly-reporting.md"
    assert_path_exists File.join(@path, file)

    history = git("log", "--format=%H", "--", file).split("\n")
    assert_equal 2, history.length, "the correction is a commit, not a rewrite"
    assert_includes read(file), "contradicted by a later call", "the mirror says why it was corrected"

    original = git("show", "#{history.last}:#{file}")
    assert_includes original, "Acme wants monthly reporting"
    assert_not_includes original, "contradicted by a later call",
                        "the version before the correction is still readable"
  end

  # Two artifacts under one name are two versions of a file, not a collision the
  # export gets to resolve by dropping one. git already has an answer for this.
  test "a second artifact under a name already used is the next version of that file" do
    first = "draft one #{SecureRandom.hex(8)}"
    second = "draft two #{SecureRandom.hex(8)}"

    artifact(name: "notes.txt", content: first)
    artifact(name: "notes.txt", content: second)
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 2, shas.length
    assert_equal second, read("artifacts/notes.txt")
    assert_equal first, git("show", "#{shas.first}:artifacts/notes.txt")
  end

  # A name in a payload is content, and content chose neither the path nor the
  # directory. An export that joined it onto the repository path would write
  # wherever an uploader asked it to.
  test "a name that tries to leave the repository does not" do
    content = "escaped #{SecureRandom.hex(8)}"

    artifact(name: "../../escape.txt", content:)
    RecordStore::GitExport.call(@channel, path: @path)

    written = git("ls-files").split("\n").grep(%r{\Aartifacts/})
    assert_equal 1, written.length
    assert_equal content, read(written.first)
    assert_not_includes written.first, "..", "the name is sanitised, not joined"

    refute_path_exists File.expand_path("../escape.txt", @path)
    refute_path_exists File.expand_path("../../escape.txt", @path)
  end

  # Article P5. The export is one room's record; another room's entries are not
  # this mirror's to hold, whatever else is in the same database.
  test "the mirror holds one room's journal and no other's" do
    said = message(body: "ours")
    other = channel(name: "Marketing")
    RecordStore::Append.call(channel: other, kind: "message.created", subject: nil,
                             payload: { "body" => "theirs" })

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 1, shas.length
    assert_not_includes read("messages/#{month_of(said)}.jsonl"), "theirs"
  end

  private
    # The payloads below are the ones the controllers and the rail journal
    # today, copied rather than referenced: the export reads envelopes out of
    # the object store, so what those envelopes contain is its whole input.

    def message(body:, author: @alice)
      written = @channel.messages.create!(author:, body:)
      RecordStore::Append.call(channel: @channel, kind: "message.created", subject: written,
                               payload: MessageSerializer.call(written).as_json)
    end

    def memory(title:, trust: "human", author: @alice, run: nil)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { "action" => "written", "uri" => "#{@channel.memory_uri}#{title.parameterize}",
                   "title" => title, "trust" => trust, "author_id" => author.id,
                   "run_id" => run&.id }
      )
    end

    def supersede(title:, reason:, author: @alice, run: nil)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { "action" => "supersede", "uri" => "#{@channel.memory_uri}#{title.parameterize}",
                   "reason" => reason, "trust" => "agent", "author_id" => author.id,
                   "run_id" => run&.id }
      )
    end

    def artifact(name:, content: nil, content_type: "text/plain", run: nil)
      # Fresh bytes per run: the test object store is Disk under tmp/storage and
      # nothing empties it between runs.
      content ||= "work product #{SecureRandom.hex(8)}"
      run ||= agent_run(user: @alice, channel: @channel)

      RecordStore::Append.call(
        channel: @channel, kind: "artifact", subject: nil,
        payload: { "name" => name, "kind" => "file",
                   "sha256" => RecordStore::Objects.current.put(content),
                   "byte_size" => content.bytesize, "content_type" => content_type,
                   "run_id" => run.id }
      )
    end

    def tamper(**fields)
      state = JSON.parse(read(STATE_FILE)).merge(fields.transform_keys(&:to_s))
      File.write(File.join(@path, STATE_FILE), JSON.generate(state))
    end

    def git(*args)
      out, err, status = Open3.capture3("git", "-C", @path, *args)
      assert status.success?, "git #{args.join(' ')} failed: #{err}"
      out
    end

    # Oldest first, which is the order the room recorded things in.
    def shas = git("log", "--reverse", "--format=%H").split("\n")

    def author_of(sha) = git("show", "-s", "--format=%an <%ae>", sha).strip

    def committer_of(sha) = git("show", "-s", "--format=%cn <%ce>", sha).strip

    def added_in(sha)
      git("show", "--diff-filter=A", "--pretty=format:", "--name-only", sha).split("\n").grep_v(/\A\s*\z/)
    end

    def read(path) = File.read(File.join(@path, path))

    def month_of(entry) = entry.created_at.utc.strftime("%Y-%m")

    def front_matter(text)
      block = text[/\A---\n(.*?)\n---\n/m, 1]
      assert_not_nil block, "the file opens with no front matter"
      block.lines.to_h { |line| line.split(":", 2).then { |key, value| [ key.strip, value.to_s.strip ] } }
    end
end
