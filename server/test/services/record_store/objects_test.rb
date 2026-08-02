require "test_helper"

class RecordStore::ObjectsTest < ActiveSupport::TestCase
  setup do
    @objects = RecordStore::Objects.current
  end

  test "content comes back exactly as it went in" do
    sha = @objects.put("the room remembers")

    assert_equal "the room remembers", @objects.get(sha)
  end

  test "the address is the SHA-256 of the content" do
    content = "the room remembers"

    assert_equal Digest::SHA256.hexdigest(content), @objects.put(content)
  end

  # A record payload is bytes, not text: a PNG, a tarball, a transcript in an
  # encoding nobody declared. Anything that reads it as a String with an
  # encoding will corrupt it long before anyone notices.
  test "binary content survives, NUL bytes and invalid UTF-8 included" do
    content = "\x00\xff\xfe binary \x00 tail".b

    sha = @objects.put(content)
    stored = @objects.get(sha)

    assert_equal content.bytes, stored.bytes
    assert_equal Encoding::BINARY, stored.encoding
  end

  # Content addressing earns its keep here: the same bytes offered twice are one
  # object, so a re-put is an address lookup rather than a second upload.
  test "storing the same content twice stores one object" do
    # Fresh bytes, because the store outlives the suite: the Disk service keeps
    # tmp/storage between runs, and a fixed string would be already-stored on
    # the second run — the assertion would then pass without proving anything.
    content = "written twice #{SecureRandom.hex(8)}"
    uploads = 0
    sha = nil
    second = nil

    ActiveSupport::Notifications.subscribed(->(*) { uploads += 1 }, "service_upload.active_storage") do
      sha = @objects.put(content)
      second = @objects.put(content)
    end

    assert_equal sha, second
    assert_equal 1, uploads, "the second put must not upload the content again"
    assert_equal content, @objects.get(sha)
  end

  test "different content gets a different address" do
    refute_equal @objects.put("one"), @objects.put("another")
  end

  # The layout is part of the contract: later cards reference payloads by their
  # digest, and a key derived differently would orphan everything already stored.
  test "an object is keyed by its digest under record/sha256" do
    sha = @objects.put("addressed")

    assert ActiveStorage::Blob.service.exist?("record/sha256/#{sha}")
  end

  test "an address nothing was stored under answers nothing, and does not raise" do
    unknown = Digest::SHA256.hexdigest("never stored")

    assert_nil @objects.get(unknown)
    assert_equal false, @objects.exists?(unknown)
  end

  test "exists? answers for content that is there" do
    assert_equal true, @objects.exists?(@objects.put("present"))
  end

  test "current hands out one store" do
    assert_same RecordStore::Objects.current, RecordStore::Objects.current
  end
end
