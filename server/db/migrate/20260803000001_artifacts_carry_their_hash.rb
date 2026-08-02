class ArtifactsCarryTheirHash < ActiveRecord::Migration[8.1]
  # Where an artifact's bytes are is no longer a question about Active Storage:
  # they are in the record store, addressed by their digest, and the row names
  # that address. Size and type come along because a listing needs both and
  # neither is worth a fetch from the bucket to answer.
  #
  # All three are null-true and none of them is unique. Rows written before this
  # card have an attachment instead and keep it — nothing migrates them — so a
  # NOT NULL here would be a constraint the existing table cannot meet. The
  # index is plain for the same reason it is not unique: two rooms storing the
  # same file hold one object and two rows naming it, which is the point of
  # addressing content rather than locations.
  def change
    add_column :artifacts, :sha256, :string, null: true
    add_column :artifacts, :byte_size, :bigint, null: true
    add_column :artifacts, :content_type, :string, null: true

    add_index :artifacts, :sha256
  end
end
