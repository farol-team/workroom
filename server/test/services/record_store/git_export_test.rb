require "test_helper"
require "rake"
require "tmpdir"
require "open3"

Rails.application.load_tasks unless Rake::Task.task_defined?("record:verify")

# The mirror spike #45 asked for. The journal already says what happened in a
# room and in which order; this replays it into a git repository, one commit per
# entry, so that `git log` over a folder answers "what does this room know, and
# when did it learn it" with no server, no database and no account in the way.
#
# The export invents nothing and asks nothing. Every file it writes, every name
# and every date on every commit comes out of an envelope that was already in
# the object store — including a memory entry's detail, because a journal that
# needs a live store to be replayed is not a record of anything. The store holds
# what a room currently knows; the journal holds what it learned and when, and
# only one of those can be exported years later or superseded and still read.
class RecordStore::GitExportTest < ActiveSupport::TestCase
  STATE_FILE = ".workroom-export.json".freeze

  setup do
    skip "git is not installed" unless system("git", "--version", out: File::NULL, err: File::NULL)

    @channel = channel(name: "Meetings")
    @alice = user(name: "Alice")
    @root = Dir.mktmpdir("wr-export")
    # A directory the operator has not created: `bin/rails record:export[meetings,
    # /tmp/wr-export]` is run against a path that does not exist yet. Two levels
    # below @root, so that a name climbing out of the repository still lands
    # somewhere this test owns and can assert about.
    @path = File.join(@root, "mirrors", "meetings")
  end

  teardown do
    FileUtils.remove_entry(@root) if @root && File.exist?(@root)
    # `Memory::Store.current=` pins a process-wide store that `current`
    # never un-resolves on its own; leaving one behind makes the suite
    # order-dependent (channel_context_test.rb does the same).
    Memory::Store.current = nil
  end

  # Three kinds, one of each, in the order a room produces them.
  test "a room's journal becomes one commit per entry, in the order the room recorded them" do
    said = posted(body: "shall we meet Tuesday")
    remembered = memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")
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

  # A room nobody has written in yet is not an error and not a wedge:
  # the mirror is a valid repository with nothing in it, its state file
  # says "nothing exported yet", and the day the first entry lands the
  # export continues from there — the chain check has no seq 0 to
  # verify, so it must not raise on a mirror that never forked.
  test "an empty journal mirrors as an empty repository the next export continues from" do
    first = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 0, first.entries_exported
    assert_nil first.head_sha
    assert_path_exists File.join(@path, ".git")

    state = JSON.parse(read(STATE_FILE))
    assert_equal @channel.slug, state["channel"]
    assert_equal 0, state["last_seq"]
    assert_nil state["last_hash"]

    posted(body: "shall we meet Tuesday")
    second = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 1, second.entries_exported
    assert_equal [ "shall we meet Tuesday" ], shas.map { |sha| subject_of(sha) }
  end

  # `git log --oneline` is the artifact this card exists to produce. Every
  # commit carrying the same subject would satisfy every count in this file and
  # be worthless to read, so each kind says what it was in the words the room
  # used: what was said, what was remembered, what arrived.
  test "a commit says which thing happened, in the room's own words" do
    posted(body: "shall we meet Tuesday")
    memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")
    artifact(name: "notes.txt")

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal [ "shall we meet Tuesday",
                   "written: Acme wants monthly reporting",
                   "artifact: notes.txt" ],
                 shas.map { |sha| subject_of(sha) }
  end

  # A subject is a line, and a message is not. The rest of what was said belongs
  # in the mirror, but not in the one line every git tool truncates for itself.
  test "a long message keeps its subject to a line" do
    said = "Tuesday is fine for me, though we should also cover the reporting cadence " \
           "and whatever Acme asked for last week"

    entry = posted(body: "#{said}\n\nand a second paragraph nobody needs in a subject")
    RecordStore::GitExport.call(@channel, path: @path)

    subject = subject_of(shas.last)
    assert_equal said[0, 60], subject, "the subject is the start of what was said, kept to a line"
    assert_equal 1, read("messages/#{month_of(entry)}.jsonl").lines.length,
                 "a multi-line message is still one JSON line"
  end

  # git folds a non-blank-separated newline into the subject, so truncating the
  # body to 60 chars is not "the first line": with a short first line the two
  # rules part ways, and `git log --oneline` reads as the run-on noise this
  # suite's subjects exist to prevent.
  test "a message's subject is its first line, not the first 60 characters" do
    posted(body: "Tuesday works\nLet's do 3pm")

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal "Tuesday works", subject_of(shas.last)
  end

  # The Behavior contract is that `git log` answers when the room learned
  # something. Left to git, every commit is dated when the export ran, and a
  # mirror of two years of work reads as a single afternoon — worse, the second
  # export dates the first entries months after the events they describe.
  test "a commit is dated when the room learned it, not when the mirror was made" do
    entries = travel_to(3.months.ago) do
      [ posted(body: "shall we meet Tuesday"),
        memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month."),
        artifact(name: "notes.txt") ]
    end

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal entries.length, shas.length, "one commit per entry, whatever the kind"
    entries.zip(shas).each do |entry, sha|
      assert_equal entry.created_at.utc.iso8601, authored_at(sha).utc.iso8601
      assert_equal entry.created_at.utc.iso8601, committed_at(sha).utc.iso8601
    end

    # The front matter's `recorded` is the same fact in the file itself. Outside
    # a travel_to it would sit milliseconds from export time, and an export that
    # stamped the file "now" would pass — here "now" and "recorded" are three
    # months apart.
    front = front_matter(read("memory/acme-wants-monthly-reporting.md"))
    assert_in_delta entries.second.created_at, front["recorded"].to_time, 5

    # And the month's file is named for when the message happened — for every
    # fixture created at export time the two months are the same string, so
    # only a travelled entry separates "the month it happened" from "the month
    # the export ran".
    assert_path_exists File.join(@path, "messages/#{month_of(entries.first)}.jsonl")
  end

  # The shape spike #45 printed: readable markdown, and every field a memory
  # entry carries surviving the trip. A mirror whose provenance is missing is a
  # folder of claims nobody can audit (Article P4).
  #
  # The detail is the point of the file, so it travels in the envelope with
  # everything else. A mirror of titles alone is not the readable markdown this
  # card promises, and a mirror that fetched the detail from the store would be
  # readable only for as long as the store still agreed.
  test "a memory write is markdown carrying what was recorded, by whom, and how far it is trusted" do
    detail = "Acme's ops lead asked for monthly rollups. Weekly created noise for their team."
    entry = memory(title: "Acme wants monthly reporting", detail:)

    RecordStore::GitExport.call(@channel, path: @path)

    body = read("memory/acme-wants-monthly-reporting.md")
    front = front_matter(body)

    assert_equal memory_uri("Acme wants monthly reporting"), front["uri"]
    assert_equal "human", front["trust"]
    assert_equal "Alice", front["author"]
    assert_nil front["run"], "a person's own record was nobody's turn"
    assert_match(/^recorded: ["']?\d{4}-\d\d-\d\dT[\d:.]+Z/, body,
                 "in UTC, because when must not depend on who asks")
    assert_in_delta entry.created_at, front["recorded"].to_time, 5

    assert_includes markdown_body(body), "Acme wants monthly reporting"
    assert_includes markdown_body(body), detail,
                    "the file says what the room knows, not only that it knows something"
  end

  # The seam is not the journal, and the two disagree constantly: entries get
  # superseded, an external context store holds its own copy and can be away
  # (#146), and a room mirrored a year later asks about uris nothing answers to
  # any more. So the export does not ask.
  #
  # Memory::Store's own base class is the store that answers nothing — every
  # read on it raises — which makes this the whole claim in one line: with the
  # room's knowledge unreachable, the mirror still comes out complete. And the
  # envelope says something the store does not, so an export that quietly read
  # the store's row directly (past the seam, Article S1) is caught as well as
  # one that called the store.
  test "the export replays the journal and asks the memory store nothing" do
    Memory::Store.current.write(@channel, title: "Acme wants monthly reporting",
                                detail: "what the store holds", trust: "human", author: @alice)
    RecordStore::Append.call(
      channel: @channel, kind: "memory", subject: nil,
      payload: { action: "written", uri: memory_uri("Acme wants monthly reporting"),
                 title: "Acme wants monthly reporting", detail: "what the envelope holds",
                 trust: "human", author_id: @alice.id }
    )
    posted(body: "shall we meet Tuesday")
    artifact(name: "notes.txt")

    with_store(Memory::Store.new) do
      RecordStore::GitExport.call(@channel, path: @path)
    end

    assert_equal 3, shas.length
    body = read("memory/acme-wants-monthly-reporting.md")
    assert_includes markdown_body(body), "what the envelope holds"
    assert_not_includes markdown_body(body), "what the store holds",
                        "the mirror replays the envelope, not whatever the store holds today"
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
    said = posted(body: "shall we meet Tuesday")

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
    said = posted(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)

    posted(body: "Tuesday works")
    RecordStore::GitExport.call(@channel, path: @path)

    lines = read("messages/#{month_of(said)}.jsonl").lines
    assert_equal 2, lines.length
    assert_equal "shall we meet Tuesday", JSON.parse(lines.first)["body"]
    assert_equal "Tuesday works", JSON.parse(lines.last)["body"]
  end

  # The state file is what makes the second run a fast-forward rather than a
  # second history of the same events.
  test "the repository records how far the journal has been exported" do
    posted(body: "shall we meet Tuesday")
    last = memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")

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
    posted(body: "shall we meet Tuesday")
    memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")
    first = RecordStore::GitExport.call(@channel, path: @path)
    already = shas

    posted(body: "Tuesday works")
    last = artifact(name: "agenda.md")
    second = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 2, first.entries_exported
    assert_equal 2, second.entries_exported
    assert_equal 4, shas.length
    assert_equal already, shas.first(2), "the mirror fast-forwards; it does not rewrite"
    assert_equal shas.last, second.head_sha

    # The state file is what the next run resumes from, so it must have moved:
    # left at the first export's seq, a third run would re-commit seq 3 and 4
    # and duplicate the month's lines.
    state = JSON.parse(read(STATE_FILE))
    assert_equal last.seq, state["last_seq"]
    assert_equal last.entry_hash, state["last_hash"]
  end

  test "an export with nothing new to say writes no commit" do
    said = posted(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)
    head = shas.last

    again = RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 0, again.entries_exported
    assert_equal [ head ], shas
    assert_equal head, again.head_sha
    assert_equal 1, read("messages/#{month_of(said)}.jsonl").lines.length,
                 "a no-op run touches nothing — the month's file is exactly as the first run left it"
  end

  # The one thing a mirror must never do quietly: fork from the journal it
  # claims to mirror. A state file that disagrees about where the chain was is
  # tampering, and the export stops rather than appending onto it — and stops
  # again next time, because an abort that repairs the state file it distrusts
  # is a fork that heals itself into place.
  test "a state file that disagrees with the journal stops the export" do
    posted(body: "shall we meet Tuesday")
    RecordStore::GitExport.call(@channel, path: @path)
    head = shas.last

    tamper(last_hash: "0" * 64)
    tampered = read(STATE_FILE)
    posted(body: "after the tampering")

    assert_raises RecordStore::GitExport::ChainMismatch do
      RecordStore::GitExport.call(@channel, path: @path)
    end

    assert_equal [ head ], shas, "an export that refuses writes nothing"
    assert_equal tampered, read(STATE_FILE), "the refusal does not quietly repair what it refused"
  end

  # The other way a mirror forks: the right repository for the wrong room.
  # The state file names the channel it was built from, and that name is there
  # to be read — an export that only checks how far it got would find nothing
  # at last_seq + 1 in the second room's shorter journal, report nothing to do,
  # and leave the operator believing Marketing had been mirrored into a folder
  # that holds Meetings (Article P5).
  test "a mirror built from one room refuses to become another room's" do
    posted(body: "shall we meet Tuesday")
    memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")
    RecordStore::GitExport.call(@channel, path: @path)
    ours = shas

    other = channel(name: "Marketing")
    RecordStore::Append.call(channel: other, kind: "message.created", subject: nil,
                             payload: { "body" => "theirs" })

    assert_raises RecordStore::GitExport::ChainMismatch do
      RecordStore::GitExport.call(other, path: @path)
    end

    assert_equal ours, shas, "the refusal leaves the first room's mirror as it was"
    assert_equal @channel.slug, JSON.parse(read(STATE_FILE))["channel"]
  end

  # The same refusal where the name cannot tell the two rooms apart. Slugs are
  # unique per workspace, not globally, so "meetings" in Globex and "meetings"
  # here are two different rooms with one name — and a mirror that recognises
  # its own by name alone would fast-forward one workspace's folder with
  # another workspace's record, which is the failure Article P5 is about.
  test "a mirror refuses another workspace's room of the same name" do
    globex = workspace(name: "Globex")
    theirs = room_in(globex, slug: "meetings")
    mine = room_in(Current.workspace, slug: "meetings")

    RecordStore::GitExport.call(mine, path: @path)
    ours = shas

    assert_raises RecordStore::GitExport::ChainMismatch do
      globex.entered { RecordStore::GitExport.call(theirs, path: @path) }
    end

    assert_equal ours, shas, "one folder, one room's record"
  end

  # Commit identity comes out of the entry, so `git log` answers who as well as
  # what. A person's own name and address, because that is what the record says.
  test "what a person recorded is committed under their name" do
    posted(body: "shall we meet Tuesday")

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal "Alice <#{@alice.email}>", author_of(shas.last)
  end

  # The memory envelope is the one entry that names its author by id alone: a
  # message carries its author whole, an artifact names a run, but a person's
  # memory write carries `author_id` and nothing else. An export that resolves
  # identity only from `payload["author"]` commits every memory entry as the
  # exporter itself and still passes everything above.
  test "what a person remembered is committed under their name, resolved from the id the envelope carries" do
    memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal "Alice <#{@alice.email}>", author_of(shas.last)
  end

  # An agent's write is not the person's own assertion and must not read as one
  # (Article P4). The turn it came from is in the address, so `git log --author`
  # finds a run's work.
  #
  # The action is "remember" because that is the only word the rail writes — an
  # export that recognises the person's "written" alone drops every entry an
  # agent ever made and still looks complete.
  test "what an agent recorded names the run it came from" do
    run = agent_run(user: @alice, channel: @channel)

    remembered(title: "Pricing objection", detail: "Setup cost, not price.", run:)
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 1, shas.length, "an agent's write is an entry the mirror holds like any other"
    assert_equal "Alice's agent <agent+#{run.id}@workroom.local>", author_of(shas.last)
    assert_equal "remember: Pricing objection", subject_of(shas.last)

    body = read("memory/pricing-objection.md")
    front = front_matter(body)
    assert_equal "agent", front["trust"]
    assert_equal memory_uri("Pricing objection"), front["uri"]
    assert_equal "Alice's agent", front["author"],
                 "an agent's inference is not the person's own assertion (Article P4)"
    assert_equal run.id, front["run"], "the turn it came from, readable offline (Article P4)"
    assert_includes markdown_body(body), "Setup cost, not price.",
                    "what the agent recorded, not only that it did"
  end

  # An artifact is raw bytes on disk: nothing inside the file says where it came
  # from, so the commit is the only provenance the mirror carries for it. The
  # entry names a run and no author, which makes run -> session -> person the
  # step an export is likeliest to skip — and skipping it turns work somebody's
  # agent produced into work the exporter appears to have written itself.
  #
  # Bob's run rather than Alice's, so resolving it is the only way to get the
  # name right.
  test "an artifact is committed under the run that produced it" do
    bob = user(name: "Bob")
    run = agent_run(user: bob, channel: @channel)

    artifact(name: "notes.txt", run:)
    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 1, shas.length
    assert_equal "Bob's agent <agent+#{run.id}@workroom.local>", author_of(shas.last)
    assert_equal "WorkRoom <record@workroom.local>", committer_of(shas.last)
  end

  # Author is whoever the entry came from; committer is the export itself, for
  # every commit alike. The two questions are different, and flattening them
  # loses the one the mirror can actually vouch for.
  test "every commit is committed by the export, whoever authored it" do
    posted(body: "shall we meet Tuesday")
    remembered(title: "Pricing objection", detail: "Setup cost, not price.",
               run: agent_run(user: @alice, channel: @channel))

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal [ "WorkRoom <record@workroom.local>" ] * 2, shas.map { |sha| committer_of(sha) }
  end

  # Article P3: a correction is a new entry that supersedes the old one, and the
  # old one stays readable. Exported as a deletion — or as an edit with no trace
  # — the mirror would be the memory model turned off.
  #
  # By the time the export runs, the store has already dropped the entry from
  # what the room currently knows: both commits are replayed from envelopes, and
  # the first one still has to produce the detail as it stood. That is the whole
  # reason the envelope carries it.
  test "a supersession is a new version of the file, and the old one is still in the history" do
    entry = memory(title: "Acme wants monthly reporting", detail: "First Tuesday of the month.")
    superseded(title: "Acme wants monthly reporting", reason: "contradicted by a later call")

    assert_nil Memory::Store.current.fetch(memory_uri("Acme wants monthly reporting")),
               "the premise: what the room currently knows no longer includes it"

    RecordStore::GitExport.call(@channel, path: @path)

    file = "memory/acme-wants-monthly-reporting.md"
    assert_path_exists File.join(@path, file)

    history = git("log", "--format=%H", "--", file).split("\n")
    assert_equal 2, history.length, "the correction is a commit, not a rewrite"

    # The supersede envelope carries why and not what — it is a correction, and
    # the entry it corrects is named by uri. So the new version says which entry
    # this is and why it no longer stands; the version it replaced says what it
    # said, one commit back.
    current = read(file)
    assert_includes markdown_body(current), "contradicted by a later call",
                    "the mirror says why it was corrected"
    assert_not_includes markdown_body(current), "First Tuesday of the month.",
                        "the correction says why, not what — the what is one commit back"
    assert_equal memory_uri("Acme wants monthly reporting"), front_matter(current)["uri"]
    assert_match(/\Asupersede: /, subject_of(shas.last))

    original = git("show", "#{history.last}:#{file}")
    assert_includes original, "First Tuesday of the month.",
                    "the version before the correction still says what the room was told"
    assert_not_includes original, "contradicted by a later call"

    assert_equal entry.seq + 1, @channel.channel_records.order(:seq).last.seq
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
  test "an artifact name that tries to leave the repository does not" do
    content = "escaped #{SecureRandom.hex(8)}"

    artifact(name: "../../escape.txt", content:)
    RecordStore::GitExport.call(@channel, path: @path)

    written = git("ls-files").split("\n").grep(%r{\Aartifacts/})
    assert_equal 1, written.length
    assert_equal content, read(written.first)
    assert_not_includes written.first, "..", "the name is sanitised, not joined"

    assert_no_strays
  end

  # An absolute name is the same hazard with the climb already done:
  # `File.join(repo, "artifacts", name)` does not absolutize, so only
  # sanitizing the name keeps the file inside. Placed under @root so the
  # strays check catches it if it escapes.
  test "an artifact name that is absolute does not leave the repository either" do
    content = "escaped #{SecureRandom.hex(8)}"

    artifact(name: File.join(@root, "absolute-escape.txt"), content:)
    RecordStore::GitExport.call(@channel, path: @path)

    written = git("ls-files").split("\n").grep(%r{\Aartifacts/})
    assert_equal 1, written.length
    assert_equal 1, written.first.count("/"),
                 "one file directly under artifacts/ — not the server's own path rebuilt inside the repo"
    assert_includes written.first, "absolute-escape"
    assert_equal content, read(written.first)

    assert_no_strays
  end

  # The same hazard by the other door. A uri is not a filename either, and the
  # server does not build every uri it stores: an external context store hands
  # back what it was given, and the journal keeps whatever it said.
  test "a memory uri that tries to leave the repository does not" do
    RecordStore::Append.call(
      channel: @channel, kind: "memory", subject: nil,
      payload: { action: "written", uri: "#{@channel.memory_uri}../../escape",
                 title: "Escaped", trust: "human", author_id: @alice.id }
    )

    RecordStore::GitExport.call(@channel, path: @path)

    written = git("ls-files").split("\n").grep(%r{\Amemory/})
    assert_equal 1, written.length
    assert_not_includes written.first, "..", "the uri tail is sanitised, not joined"
    assert_includes read(written.first), "Escaped"

    assert_no_strays
  end

  # Article P5. The export is one room's record; another room's entries are not
  # this mirror's to hold, whatever else is in the same database.
  test "the mirror holds one room's journal and no other's" do
    said = posted(body: "ours")
    other = channel(name: "Marketing")
    RecordStore::Append.call(channel: other, kind: "message.created", subject: nil,
                             payload: { "body" => "theirs" })

    RecordStore::GitExport.call(@channel, path: @path)

    assert_equal 1, shas.length
    assert_not_includes read("messages/#{month_of(said)}.jsonl"), "theirs"
  end

  # --- the rake task ---------------------------------------------------------
  #
  # The task holds no export logic, so what is worth proving about it is what
  # the service cannot: which room a slug reaches, whose it is, and what the
  # shell gets back. Reaching it is not a detail — the boundary is the
  # database's, and a connection that has entered no workspace sees no rooms and
  # would mirror an empty repository over the operator's folder and call it
  # done.

  test "the task mirrors the room it was given" do
    posted(body: "shall we meet Tuesday")

    run = run_task(@channel.slug, @path)

    assert_not run.aborted, "#{run.out}#{run.err}"
    assert_equal 1, shas.length
    assert_equal "shall we meet Tuesday", subject_of(shas.last)
    assert_includes run.out, "meetings"
    assert_includes run.out, "1 entries",
                    "the run reports what it did — a cron's silence reads as nothing happened"
  end

  # A room in a workspace this connection has not entered. Without entering it
  # the slug resolves to nothing, and the run that mirrors nothing is the run
  # that reports success.
  test "the task enters a workspace to find its rooms" do
    theirs = workspace(name: "Globex")
    room_in(theirs, slug: "marketing")

    run = run_task("marketing", @path)

    assert_not run.aborted, "#{run.out}#{run.err}"
    assert_equal 1, shas.length, "the room was found, entered, and mirrored"
  end

  # Slugs are unique per workspace, not globally, so a bare slug can name as
  # many rooms as there are workspaces holding one. `verify` can check them all;
  # this writes to one folder the operator named, so there is no answer that
  # mirrors both — and picking either fills that folder with a record whose
  # workspace nobody chose.
  test "a slug that names a room in more than one workspace is refused, not guessed" do
    room_in(Current.workspace, slug: "meetings")
    room_in(workspace(name: "Globex"), slug: "meetings")

    run = run_task("meetings", @path)

    assert run.aborted, "two rooms of that name left a zero exit: #{run.out}"
    refute_path_exists @path, "nothing is written to a path the run could not resolve"
  end

  # The refusal the service raises has to reach the shell as an exit, or the
  # operator's cron reports a mirror that forked as a mirror that refreshed.
  test "a mirror that disagrees with the journal fails the run, not only the call" do
    posted(body: "shall we meet Tuesday")
    run_task(@channel.slug, @path)
    head = shas.last

    tamper(last_hash: "0" * 64)
    posted(body: "after the tampering")

    run = run_task(@channel.slug, @path)

    assert run.aborted, "a forked mirror left a zero exit: #{run.out}"
    assert_equal [ head ], shas
  end

  # Silence would read as a room that was mirrored, which is the one answer this
  # must never give by accident.
  test "a slug no room anywhere answers to is refused, not passed over" do
    run = run_task("no-such-room", @path)

    assert run.aborted, "an unknown slug left a zero exit: #{run.out}"
    assert_includes run.err, "no-such-room"
    refute_path_exists @path
  end

  test "the task refuses to run without both a room and a path" do
    posted(body: "shall we meet Tuesday")

    assert run_task.aborted, "no arguments at all left a zero exit"
    assert run_task(@channel.slug).aborted, "a room with nowhere to write it left a zero exit"
    refute_path_exists @path
  end

  private
    # --- what the room actually journals ------------------------------------
    #
    # Every payload below is the one its call site appends today, copied rather
    # than referenced: the export reads envelopes out of the object store, so
    # what those envelopes contain is its whole input, and a fixture that
    # invented a tidier shape would prove only that the export can read the
    # shape this file made up.

    # app/controllers/api/v1/messages_controller.rb
    def posted(body:, author: @alice)
      written = @channel.messages.create!(author:, body:)
      RecordStore::Append.call(channel: @channel, kind: "message.created", subject: written,
                               payload: MessageSerializer.call(written).as_json)
    end

    # app/controllers/api/v1/artifacts_controller.rb — the row keeps the address
    # of bytes the record store already holds, and the entry names the row.
    def artifact(name:, content: nil, kind: "file", content_type: "text/plain", run: nil)
      content ||= "work product #{SecureRandom.hex(8)}"
      run ||= agent_run(user: @alice, channel: @channel)
      row = @channel.artifacts.create!(
        agent_run: run, name:, kind:, sha256: RecordStore::Objects.current.put(content),
        byte_size: content.bytesize, content_type:
      )

      RecordStore::Append.call(
        channel: @channel, kind: "artifact", subject: row,
        payload: row.slice(:name, :kind, :sha256, :byte_size, :content_type).merge(run_id: run.id)
      )
    end

    # app/controllers/api/v1/memory_controller.rb — a person recording something
    # the room should know. No run: nobody's turn produced it.
    #
    # The detail travels in the envelope. That field is the one thing here the
    # call site does not send yet, and this card adds it: without it the journal
    # records that the room learned something and not what, and the mirror can
    # only be rebuilt from a store that has since moved on.
    def memory(title:, detail:, author: @alice)
      Memory::Store.current.write(@channel, title:, detail:, trust: "human", author:)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { action: "written", uri: memory_uri(title), title:, detail:, trust: "human",
                   author_id: author.id }
      )
    end

    # app/services/rail/registry.rb — the same write through the rail, which
    # says "remember" and carries the turn.
    def remembered(title:, detail:, run:, author: @alice)
      Memory::Store.current.write(@channel, title:, detail:, trust: "agent", author:, source: run)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { action: "remember", uri: memory_uri(title), trust: "agent",
                   author_id: author.id, run_id: run&.id, title:, detail: }
      )
    end

    # app/services/rail/registry.rb — a correction, which carries why and not
    # what: the title is not in this envelope because it is not in that call.
    def superseded(title:, reason:, run: nil, author: @alice)
      Memory::Store.current.supersede(memory_uri(title), reason:)
      RecordStore::Append.call(
        channel: @channel, kind: "memory", subject: nil,
        payload: { action: "supersede", uri: memory_uri(title), trust: "agent",
                   author_id: author.id, run_id: run&.id, reason: }
      )
    end

    # What Memory::Local#write builds a uri from, which is what the tail of the
    # exported filename has to come from.
    def memory_uri(title) = "#{@channel.memory_uri}#{title.parameterize}"

    def with_store(store)
      previous = Memory::Store.current
      Memory::Store.current = store
      yield
    ensure
      Memory::Store.current = previous
    end

    # A room of somebody else's, with something in it. Everything inside the
    # block, because the boundary is the database's: a row for another workspace
    # written from this one is refused rather than misfiled.
    def room_in(workspace, slug:)
      workspace.entered do
        room = Channel.create!(slug:, name: slug.capitalize)
        person = user(name: "Bob", workspace:)
        written = room.messages.create!(author: person, body: "#{slug} opened")
        RecordStore::Append.call(channel: room, kind: "message.created", subject: written,
                                 payload: MessageSerializer.call(written).as_json)
        room
      end
    end

    # --- the repository the export produced ---------------------------------

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

    def subject_of(sha) = git("show", "-s", "--format=%s", sha).strip

    def author_of(sha) = git("show", "-s", "--format=%an <%ae>", sha).strip

    def committer_of(sha) = git("show", "-s", "--format=%cn <%ce>", sha).strip

    def authored_at(sha) = Time.iso8601(git("show", "-s", "--format=%aI", sha).strip)

    def committed_at(sha) = Time.iso8601(git("show", "-s", "--format=%cI", sha).strip)

    def added_in(sha)
      git("show", "--diff-filter=A", "--pretty=format:", "--name-only", sha).split("\n").grep_v(/\A\s*\z/)
    end

    def read(path) = File.read(File.join(@path, path))

    def month_of(entry) = entry.created_at.utc.strftime("%Y-%m")

    # Both rungs a name could climb, asserted as emptiness rather than as the
    # absence of one filename: whatever the export wrote, it wrote inside the
    # directory it was given.
    def assert_no_strays
      assert_equal [ File.basename(@path) ], Dir.children(File.dirname(@path))
      assert_equal [ File.basename(File.dirname(@path)) ], Dir.children(@root)
    end

    # Parsed as yaml rather than split on the first colon: front matter that only
    # this suite can read is not front matter. The mirror exists to be opened by
    # the tools people already have.
    def front_matter(text)
      block = text[/\A---\n(.*?)\n---\n/m, 1]
      assert_not_nil block, "the file opens with no front matter"
      YAML.safe_load(block, permitted_classes: [ Time, Date ])
    end

    # What the file says after the provenance block. A memory file whose words
    # live only in the front matter is a YAML blob, not the readable markdown
    # this card promises — so what was recorded is asserted here, not anywhere
    # in the file.
    def markdown_body(text) = text[/\A---\n.*?\n---\n(.*)\z/m, 1] || ""

    # --- the task ------------------------------------------------------------

    TaskRun = Struct.new(:out, :err, :aborted)

    # In process, which also means under the app role the suite confines to —
    # the role a deployment uses, and the one row-level security applies to. Run
    # any other way the export would read the record through a connection that
    # bypasses the boundary, and which room a slug reaches is the whole question.
    def run_task(*args)
      Rake::Task["record:export"].reenable
      aborted = false
      out, err = capture_io do
        Rake::Task["record:export"].invoke(*args)
      rescue SystemExit
        aborted = true
      end
      TaskRun.new(out, err, aborted)
    end
end
